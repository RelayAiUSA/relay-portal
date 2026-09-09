// relay-pwa/functions/lib/firestore-backup.mjs
//
// A full, restorable snapshot of Firestore, taken on a schedule.
//
// WHY THIS EXISTS
//
// Relay holds other businesses' customer lists - names, phone numbers,
// addresses, job history - and until now there was no way to get any of it
// back. Not from a bad migration, not from a rules mistake, not from a
// contractor deleting their own customers by accident, not from a bug in our
// own code writing over a collection. "We lost your customer list" is the kind
// of failure a small company does not survive, and it is entirely preventable.
//
// Firebase's own managed backups (scheduled backups + point-in-time recovery)
// are the better answer and remain the goal - they are transactionally
// consistent and Google-operated. They require the Blaze billing plan, which
// this project is not on. This module closes the gap in the meantime with
// something that needs no billing change at all, and it stays useful
// afterwards as an offsite second copy in a different vendor's storage.
//
// WHAT IT IS NOT
//
// Not point-in-time consistent. It walks the database document by document, so
// a write landing mid-walk can be captured on one side of a relationship and
// not the other. For a database this size the walk takes seconds, and a
// slightly-skewed snapshot beats no snapshot by an enormous margin - but do
// not describe this as equivalent to managed backups.
//
// FORMAT
//
// A flat array of { path, data }. Flat rather than nested because a full
// document path ("users/abc/customers/xyz") is all a restore needs, so
// subcollections cost nothing extra and there is no tree to walk on the way
// back in. Firestore's non-JSON types are wrapped by encodeValue() so a
// Timestamp restores as a Timestamp rather than as a string that merely looks
// like one - a restore that quietly changes every type is not a restore.

import { Timestamp, GeoPoint } from 'firebase-admin/firestore';

export const BACKUP_FORMAT_VERSION = 1;

// -- Type-preserving encode / decode -----------------------------------------

/**
 * Convert one Firestore value into something JSON.stringify can hold, tagging
 * the types JSON has no representation for so decodeValue can rebuild them.
 */
export function encodeValue(v) {
  if (v === null || v === undefined) return null;

  // Timestamp: duck-typed rather than instanceof, because a value read through
  // the Admin SDK can carry a Timestamp from a different module instance and
  // instanceof would silently fall through to the plain-object branch.
  if (typeof v?.toDate === 'function' && typeof v?.seconds === 'number') {
    return { __type: 'timestamp', seconds: v.seconds, nanoseconds: v.nanoseconds || 0 };
  }
  if (v instanceof Date) {
    return { __type: 'timestamp', seconds: Math.floor(v.getTime() / 1000),
             nanoseconds: (v.getTime() % 1000) * 1e6 };
  }
  // GeoPoint. Deliberately narrow: a plain object that happens to hold
  // latitude/longitude - a perfectly ordinary thing for an address record to
  // store - must NOT be encoded as a GeoPoint, or the restore would change its
  // type. Only a real GeoPoint carries isEqual().
  if (typeof v?.latitude === 'number' && typeof v?.longitude === 'number'
      && typeof v?.isEqual === 'function') {
    return { __type: 'geopoint', latitude: v.latitude, longitude: v.longitude };
  }
  // DocumentReference
  if (typeof v?.path === 'string' && typeof v?.collection === 'function') {
    return { __type: 'ref', path: v.path };
  }
  if (Buffer.isBuffer(v)) {
    return { __type: 'bytes', base64: v.toString('base64') };
  }
  if (Array.isArray(v)) return v.map(encodeValue);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = encodeValue(val);
    // A user map that itself contains a "__type" key would be mistaken for one
    // of our tags on the way back in. Wrap it so the escape is unambiguous.
    return Object.hasOwn(v, '__type') ? { __type: 'map', value: out } : out;
  }
  // A number Firestore stored as an int64 comes back as a JS number here. That
  // is lossy above 2^53, which no field in this product approaches.
  return v;
}

/** Rebuild a value produced by encodeValue. `db` is needed only for refs. */
export function decodeValue(v, db = null) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => decodeValue(x, db));

  switch (v.__type) {
    case 'timestamp': return new Timestamp(v.seconds, v.nanoseconds || 0);
    case 'geopoint':  return new GeoPoint(v.latitude, v.longitude);
    case 'bytes':     return Buffer.from(v.base64, 'base64');
    case 'ref':       return db ? db.doc(v.path) : v.path;
    // An escaped user map. Decode its ENTRIES, not the map itself: passing
    // v.value back through decodeValue would see the user's own "__type" key
    // and re-interpret it as one of our tags - which is precisely what the
    // escape exists to prevent.
    case 'map': {
      const out = {};
      for (const [k, val] of Object.entries(v.value)) out[k] = decodeValue(val, db);
      return out;
    }
    default: {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = decodeValue(val, db);
      return out;
    }
  }
}

// -- The walk ----------------------------------------------------------------

// Ceilings, so a runaway or an unexpectedly large database fails loudly inside
// the function's time budget instead of being killed halfway through and
// leaving a truncated blob that looks like a complete backup.
export const MAX_DOCS  = 100_000;
export const MAX_DEPTH = 8;   // users/{uid}/customers/{id} is depth 2

/**
 * Walk every collection and subcollection reachable from the database root.
 *
 * Subcollections are enumerated per document via ref.listCollections(), which
 * is the only way to find them: Firestore has no global index of subcollection
 * names, and a subcollection whose parent document does not exist is still
 * real data. Missing one silently is exactly how a backup turns out to be
 * useless on the day it is needed, so nothing here is hardcoded to a known
 * collection list - new collections are picked up without a code change.
 *
 * @returns {{ version, takenAt, docCount, collections, docs }}
 */
export async function exportDatabase(db, { maxDocs = MAX_DOCS, log = () => {} } = {}) {
  const docs        = [];
  const collections = new Set();

  async function walkCollection(colRef, depth) {
    if (depth > MAX_DEPTH) {
      throw new Error(`Backup aborted: subcollection nesting deeper than ${MAX_DEPTH} at ${colRef.path}`);
    }
    collections.add(colRef.path);

    // Read the whole collection. These are small; if any collection grows past
    // a few thousand documents this should page with orderBy(__name__)/startAfter.
    const snap = await colRef.get();
    for (const doc of snap.docs) {
      if (docs.length >= maxDocs) {
        throw new Error(`Backup aborted: more than ${maxDocs} documents. Raise MAX_DOCS deliberately, or page the export.`);
      }
      docs.push({ path: doc.ref.path, data: encodeValue(doc.data()) });
      const subs = await doc.ref.listCollections();
      for (const sub of subs) await walkCollection(sub, depth + 1);
    }
    log(`[backup] ${colRef.path}: ${snap.size} docs`);
  }

  const roots = await db.listCollections();
  for (const root of roots) await walkCollection(root, 0);

  return {
    version:     BACKUP_FORMAT_VERSION,
    takenAt:     new Date().toISOString(),
    docCount:    docs.length,
    collections: [...collections].sort(),
    docs,
  };
}

// -- Retention ---------------------------------------------------------------

/**
 * Which backup keys to delete. Pure, so the rule can be tested without a store.
 *
 * Keeps every backup from the last `dailyDays` days, plus the first-of-month
 * snapshot for `monthlyMonths` months. Monthlies matter because the failure
 * mode backups exist for is often slow: a bug that has been quietly corrupting
 * one field for six weeks is not recoverable from a window of dailies that are
 * all already wrong.
 *
 * Keys are `YYYY-MM-DD.json`.
 */
export function keysToDelete(keys, { now = new Date(), dailyDays = 30, monthlyMonths = 12 } = {}) {
  const cutoffDaily = new Date(now.getTime() - dailyDays * 86400_000);
  const cutoffMonth = new Date(now.getTime() - monthlyMonths * 31 * 86400_000);

  return keys.filter(key => {
    const m = /^(\d{4})-(\d{2})-(\d{2})\.json$/.exec(key);
    if (!m) return false;                     // never delete something we do not recognise
    const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return false;
    if (date >= cutoffDaily) return false;    // inside the daily window
    if (m[3] === '01' && date >= cutoffMonth) return false; // a kept monthly
    return true;
  });
}

/** The blob key for a given day. */
export function backupKey(now = new Date()) {
  return `${now.toISOString().slice(0, 10)}.json`;
}
