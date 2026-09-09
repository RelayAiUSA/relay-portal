#!/usr/bin/env node
// scripts/firestore-restore.mjs
//
// The way back. A backup nobody has ever restored is a hypothesis, not a
// backup, so this is a real, runnable tool - and it is deliberately in the
// repo rather than in someone's head.
//
//   node scripts/firestore-restore.mjs --list
//       What snapshots exist, when they were taken, how big.
//
//   node scripts/firestore-restore.mjs --pull [--key 2026-09-09.json] [--out FILE]
//       Download a snapshot to a local file. THE OFFSITE COPY. Run this
//       before any migration, rules change or bulk edit.
//
//   node scripts/firestore-restore.mjs --restore FILE [--only users/abc] [--confirm]
//       Write documents back into Firestore. DRY RUN unless --confirm is
//       given: it prints exactly what it would write and changes nothing.
//
// A restore MERGES by default: it sets each document from the snapshot and
// leaves documents created since alone. --purge additionally deletes documents
// that exist now and did not exist in the snapshot, which is what you want
// after a corruption and emphatically not what you want after simply losing
// one record. Nothing here deletes anything without both --confirm and --purge.
//
// ENV (same values Netlify holds; read them from the Netlify UI, do not commit
// them anywhere):
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//   NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID   (only for --list and --pull)

import { readFile, writeFile } from 'node:fs/promises';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore }                  from 'firebase-admin/firestore';
import { getStore }                      from '@netlify/blobs';
import { decodeValue }                   from '../relay-pwa/functions/lib/firestore-backup.mjs';

const STORE_NAME = 'firestore-backups';

const args = process.argv.slice(2);
const has  = f => args.includes(f);
const val  = f => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };

function blobStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    throw new Error('NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required to reach the backup store.');
  }
  return getStore({ name: STORE_NAME, siteID, token });
}

function db() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not set.');
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  console.log(`Firestore project: ${projectId}`);
  return getFirestore();
}

async function list() {
  const { blobs } = await blobStore().list();
  const rows = blobs.map(b => b.key).sort().reverse();
  if (!rows.length) { console.log('No backups found. Has firestore-backup run yet?'); return; }
  console.log(`${rows.length} snapshot(s), newest first:\n`);
  for (const key of rows) console.log('  ' + key);
}

async function pull() {
  const store = blobStore();
  let key = val('--key');
  if (!key) {
    const { blobs } = await store.list();
    key = blobs.map(b => b.key).sort().pop();
    if (!key) throw new Error('No backups in the store.');
  }
  const body = await store.get(key);
  if (!body) throw new Error(`Snapshot ${key} not found.`);
  const out = val('--out') || key;
  await writeFile(out, body);
  const snap = JSON.parse(body);
  console.log(`Wrote ${out} - ${snap.docCount} documents, taken ${snap.takenAt}`);
  console.log(`Collections: ${snap.collections.join(', ')}`);
}

async function restore(file) {
  const snap = JSON.parse(await readFile(file, 'utf8'));
  if (snap.version !== 1) throw new Error(`Unsupported backup format version ${snap.version}.`);

  const only    = val('--only');
  const confirm = has('--confirm');
  const purge   = has('--purge');

  let docs = snap.docs;
  if (only) docs = docs.filter(d => d.path === only || d.path.startsWith(only + '/'));

  console.log(`Snapshot ${file}: taken ${snap.takenAt}, ${snap.docCount} documents.`);
  console.log(`Selected: ${docs.length}${only ? ` (filtered to "${only}")` : ''}`);
  if (!docs.length) { console.log('Nothing to do.'); return; }

  if (!confirm) {
    console.log('\nDRY RUN - nothing will be written. Documents that would be set:\n');
    for (const d of docs.slice(0, 50)) console.log('  ' + d.path);
    if (docs.length > 50) console.log(`  ... and ${docs.length - 50} more`);
    if (purge) console.log('\n--purge was given: documents absent from the snapshot would also be DELETED.');
    console.log('\nRe-run with --confirm to write.');
    return;
  }

  const store = db();
  let written = 0;

  // Batched, 400 at a time - under Firestore's 500-write limit with room for
  // the deletes below to share a batch if they ever do.
  for (let i = 0; i < docs.length; i += 400) {
    const batch = store.batch();
    for (const d of docs.slice(i, i + 400)) {
      batch.set(store.doc(d.path), decodeValue(d.data, store));
    }
    await batch.commit();
    written += Math.min(400, docs.length - i);
    console.log(`  restored ${written}/${docs.length}`);
  }

  if (purge) {
    const keep = new Set(docs.map(d => d.path));
    const roots = new Set(docs.map(d => d.path.split('/').slice(0, -1).join('/')));
    let deleted = 0;
    for (const colPath of roots) {
      const live = await store.collection(colPath).get();
      const stale = live.docs.filter(d => !keep.has(d.ref.path));
      for (let i = 0; i < stale.length; i += 400) {
        const batch = store.batch();
        for (const d of stale.slice(i, i + 400)) batch.delete(d.ref);
        await batch.commit();
        deleted += Math.min(400, stale.length - i);
      }
    }
    console.log(`Purged ${deleted} document(s) not present in the snapshot.`);
  }

  console.log(`\nDone. ${written} document(s) restored.`);
}

const file = val('--restore');
try {
  if (has('--list'))      await list();
  else if (has('--pull')) await pull();
  else if (file)          await restore(file);
  else {
    console.log('Usage:\n  --list\n  --pull [--key KEY] [--out FILE]\n  --restore FILE [--only PATH] [--purge] [--confirm]');
    process.exit(1);
  }
} catch (err) {
  console.error('\nFailed: ' + err.message);
  process.exit(1);
}
