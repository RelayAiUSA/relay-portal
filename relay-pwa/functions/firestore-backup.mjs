// relay-pwa/functions/firestore-backup.mjs
// Scheduled function - runs daily at 07:00 UTC (03:00 ET), an hour before
// oauth-refresh-sweep, so the snapshot is taken before anything else in the
// platform starts writing for the day.
//
// Writes a full type-preserving snapshot of Firestore to Netlify Blobs and
// prunes old ones. See lib/firestore-backup.mjs for the format, and
// scripts/firestore-restore.mjs for the way back.
//
// STORAGE
//
// Netlify Blobs, store "firestore-backups". Chosen because it needs no new
// vendor, no new credential and no billing change - the failure mode of a
// backup plan is that it never gets set up, and every extra step is a chance
// for that. It is a different system from Firestore, which is the property
// that matters: a mistake in the database cannot reach the copy.
//
// It is NOT a different company from the site, so it is not protection against
// losing the Netlify account. The offsite copy is `npm run backup:pull`
// (scripts/firestore-restore.mjs --pull), which writes the newest snapshot to
// a local file. Run it before anything risky.
//
// A scheduled function returns 403 to a manual POST. That is Netlify refusing
// the invocation, not a fault - see CLAUDE.md.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getStore }                      from '@netlify/blobs';
import { alertError }                    from './lib/alert.mjs';
import { exportDatabase, keysToDelete, backupKey } from './lib/firestore-backup.mjs';

export const config = { schedule: '0 7 * * *' };

export const STORE_NAME = 'firestore-backups';

let _db;
function getDb() {
  if (!_db) {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      });
    }
    _db = getFirestore();
  }
  return _db;
}

export default async () => {
  try {
    return await runBackup();
  } catch (err) {
    console.error('[firestore-backup] FAILED:', err);
    // A backup failing silently is the same as having no backup, so this is
    // worth an interrupt rather than a log line nobody reads.
    try {
      await alertError('firestore-backup', err, 'No snapshot was stored for today.');
    } catch (alertErr) {
      console.error('[firestore-backup] alert failed:', alertErr?.message);
    }
    return new Response('backup failed', { status: 500 });
  }
};

async function runBackup() {
  const started = Date.now();
  const db      = getDb();

  const snapshot = await exportDatabase(db, { log: msg => console.log(msg) });

  // An empty database almost certainly means the credentials are pointed
  // somewhere unexpected rather than that every record is genuinely gone.
  // Overwriting today's good backup with an empty one would turn a
  // configuration mistake into data loss, so refuse.
  if (snapshot.docCount === 0) {
    throw new Error('Refusing to store an empty backup: the export found zero documents. Check FIREBASE_PROJECT_ID and the service account.');
  }

  const body  = JSON.stringify(snapshot);
  const store = getStore(STORE_NAME);
  const key   = backupKey();

  await store.set(key, body, {
    metadata: {
      takenAt:     snapshot.takenAt,
      docCount:    snapshot.docCount,
      collections: snapshot.collections.join(','),
      bytes:       body.length,
    },
  });

  // Read it back. A write that reported success and stored nothing is the
  // exact failure this whole function exists to prevent, and it costs one call
  // to rule out. Nothing else in the system would ever notice.
  const check = await store.get(key);
  if (!check || check.length !== body.length) {
    throw new Error(`Backup ${key} did not read back intact (wrote ${body.length} bytes, read ${check ? check.length : 'nothing'}).`);
  }

  // Prune. Never before the new backup is written and verified.
  let pruned = [];
  try {
    const { blobs } = await store.list();
    pruned = keysToDelete(blobs.map(b => b.key));
    for (const old of pruned) await store.delete(old);
  } catch (err) {
    // Retention failing is untidy; it is not a lost backup. Do not let it fail
    // a run that already stored a good snapshot.
    console.warn('[firestore-backup] prune failed:', err.message);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[firestore-backup] ${key}: ${snapshot.docCount} docs across ${snapshot.collections.length} collections, ${(body.length / 1024).toFixed(1)} KB, ${secs}s${pruned.length ? `, pruned ${pruned.length}` : ''}`);

  return new Response('ok', { status: 200 });
}
