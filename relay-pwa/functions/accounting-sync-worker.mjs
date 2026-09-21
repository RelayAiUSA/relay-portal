// relay-pwa/functions/accounting-sync-worker.mjs
// Scheduled Netlify Function — runs every minute.
//
// Picks up invoices queued for accounting sync by twilio-sms.mjs and syncs
// them to Zoho Books or QuickBooks. Running the sync here (not inside the
// Twilio webhook) eliminates the duplicate-invoice risk: the webhook now
// responds to Twilio in ~2 s; Zoho/QuickBooks latency never causes a timeout
// or a Twilio retry.
//
// Queue format (_syncQueue/{invoiceId}):
//   uid        — the contractor's Firebase uid
//   invoiceId  — same as the document key
//   platform   — 'zoho' | 'quickbooks'
//   attempts   — number of sync attempts so far
//   createdAt  — server timestamp
//
// On success  → queue entry deleted, invoice doc updated by syncInvoiceToAccounting
// On failure  → attempts incremented; retired after MAX_ATTEMPTS with error written to invoice

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue }      from 'firebase-admin/firestore';
import { syncInvoiceToAccounting, syncExpenseToAccounting } from './lib/accounting-sync.mjs';
import { alertError }                    from './lib/alert.mjs';

export const config = { schedule: '* * * * *' };

const MAX_ATTEMPTS = 3;

// ── Firebase Admin — lazy singleton ──────────────────────────────────────────
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

// ── Handler ───────────────────────────────────────────────────────────────────
export default async () => {
  const db = getDb();

  // Grab up to 20 queued sync jobs, oldest first.
  let snap;
  try {
    snap = await db.collection('_syncQueue').orderBy('createdAt').limit(20).get();
  } catch (err) {
    console.error('[sync-worker] queue read failed:', err.message);
    await alertError('accounting-sync-worker:read', err, '');
    return;
  }

  if (snap.empty) return;

  console.log(`[sync-worker] processing ${snap.size} job(s)`);

  for (const qDoc of snap.docs) {
    const { uid, invoiceId, expenseId, type, attempts = 0 } = qDoc.data();

    // ── Expense sync ──────────────────────────────────────────────────────────────────────
    if (type === 'expense') {
      try {
        const expSnap = await db.collection('users').doc(uid).collection('expenses').doc(expenseId).get();
        if (!expSnap.exists) { await qDoc.ref.delete(); continue; }

        const profileSnap = await db.collection('users').doc(uid).get();
        const result = await syncExpenseToAccounting(
          db, uid, expenseId, expSnap.data(), profileSnap.data()
        );

        if (result.synced) {
          await qDoc.ref.delete();
          console.log(`[sync-worker] expense ${expenseId} synced to ${result.provider}`);
        } else {
          const nextAttempts = attempts + 1;
          if (nextAttempts >= MAX_ATTEMPTS) {
            console.error(`[sync-worker] expense ${expenseId} retired after ${MAX_ATTEMPTS} attempts`);
            await qDoc.ref.delete();
          } else {
            await qDoc.ref.update({ attempts: nextAttempts });
          }
        }
      } catch (err) {
        console.error('[sync-worker] expense sync error:', err.message);
        try { await alertError('accounting-sync-worker:expense', err, `uid=${uid} expenseId=${expenseId}`); } catch (_) {}
        const nextAttempts = attempts + 1;
        if (nextAttempts >= MAX_ATTEMPTS) { await qDoc.ref.delete(); }
        else { await qDoc.ref.update({ attempts: nextAttempts }); }
      }
      continue;
    }

    try {
      // Load the invoice and user profile.
      const [invoiceSnap, profileSnap] = await Promise.all([
        db.collection('users').doc(uid).collection('invoices').doc(invoiceId).get(),
        db.collection('users').doc(uid).get(),
      ]);

      if (!invoiceSnap.exists) {
        // Invoice was deleted — remove from queue silently.
        await qDoc.ref.delete();
        continue;
      }

      const invoiceData = invoiceSnap.data();
      const profile     = profileSnap.data() || {};

      await syncInvoiceToAccounting(db, uid, invoiceId, invoiceData, profile);

      // Success — remove from queue.
      await qDoc.ref.delete();
      console.log(`[sync-worker] synced invoice=${invoiceId} uid=${uid}`);

    } catch (err) {
      console.error(`[sync-worker] invoice=${invoiceId} uid=${uid} attempt=${attempts + 1} error:`, err.message);

      if (attempts + 1 >= MAX_ATTEMPTS) {
        // Retire the job — write the final error to the invoice doc so the
        // contractor can see it in the portal, then remove from queue.
        console.error(`[sync-worker] retiring invoice=${invoiceId} after ${MAX_ATTEMPTS} attempts`);
        try {
          await db.collection('users').doc(uid).collection('invoices').doc(invoiceId).update({
            accountingSync: {
              synced:           false,
              error:            err.message,
              provider:         qDoc.data().platform,
              retriesExhausted: true,
              failedAt:         FieldValue.serverTimestamp(),
            },
          });
          await qDoc.ref.delete();
        } catch (innerErr) {
          console.error('[sync-worker] retire write failed:', innerErr.message);
        }
        await alertError('accounting-sync-worker:retired', err, `invoice=${invoiceId} uid=${uid}`);
      } else {
        // Increment attempt counter and leave in queue for the next run.
        try {
          await qDoc.ref.update({ attempts: attempts + 1 });
        } catch (innerErr) {
          console.error('[sync-worker] attempt increment failed:', innerErr.message);
        }
      }
    }
  }
};
