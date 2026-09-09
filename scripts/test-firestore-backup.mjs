#!/usr/bin/env node
// scripts/test-firestore-backup.mjs
//
// Run:  cd relay-pwa/functions && node ../../scripts/test-firestore-backup.mjs
// (from that directory, so firebase-admin resolves)
//
// What is worth testing here is not "does it call get()". It is the two things
// that would make a backup useless on the day it is needed:
//   1. Does a restored document hold the same TYPES it had, or strings that
//      merely look like them?
//   2. Does the walk find subcollections, where most of the customer data is?
// Plus retention, because a prune bug deletes the copy you were counting on.

import {
  encodeValue, decodeValue, exportDatabase, keysToDelete, backupKey,
} from '../relay-pwa/functions/lib/firestore-backup.mjs';

// Resolve firebase-admin from the SAME place the library resolves it -
// relay-pwa/functions/node_modules. A bare import here would resolve from
// scripts/ up to the repo-root node_modules, a second copy of the package, and
// every `instanceof Timestamp` would be false for reasons that have nothing to
// do with the code under test. That false alarm cost time once already.
const { Timestamp, GeoPoint } = await import(
  new URL('../relay-pwa/functions/node_modules/firebase-admin/lib/firestore/index.js', import.meta.url).href
);

let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('  FAIL: ' + name); }
}

// ── round-trip types ─────────────────────────────────────────────────────────
{
  const ts  = Timestamp.fromDate(new Date('2026-09-08T22:38:52.123Z'));
  const gp  = new GeoPoint(42.96, -85.66);
  const buf = Buffer.from('encrypted-token-bytes');

  const doc = {
    customer:  'Andrew Zang',
    amount:    750,
    paid:      false,
    createdAt: ts,
    where:     gp,
    blob:      buf,
    nothing:   null,
    tags:      ['plumbing', 'emergency'],
    nested:    { a: { b: ts }, list: [ts, 1, 'x'] },
    // A plain map that merely LOOKS like a geopoint must survive as a map.
    address:   { latitude: 42.96, longitude: -85.66, label: 'shop' },
    // A user map carrying our own tag key must not be mistaken for a tag.
    weird:     { __type: 'timestamp', seconds: 1, note: 'user data' },
  };

  const wire = JSON.parse(JSON.stringify(encodeValue(doc)));
  const back = decodeValue(wire);

  ok('string survives',            back.customer === 'Andrew Zang');
  ok('number survives',            back.amount === 750);
  ok('boolean survives',           back.paid === false);
  ok('null survives',              back.nothing === null);
  ok('array survives',             eq(back.tags, ['plumbing', 'emergency']));
  ok('Timestamp is a Timestamp',   back.createdAt instanceof Timestamp);
  ok('Timestamp value is exact',   back.createdAt.isEqual(ts));
  ok('nested Timestamp restored',  back.nested.a.b instanceof Timestamp);
  ok('Timestamp inside array',     back.nested.list[0] instanceof Timestamp);
  ok('GeoPoint is a GeoPoint',     back.where instanceof GeoPoint);
  ok('GeoPoint value is exact',    back.where.isEqual(gp));
  ok('Buffer is a Buffer',         Buffer.isBuffer(back.blob));
  ok('Buffer bytes are exact',     back.blob.equals(buf));
  ok('lat/lng map stays a map',    !(back.address instanceof GeoPoint) && back.address.label === 'shop');
  ok('lat/lng map keeps numbers',  back.address.latitude === 42.96);
  ok('__type in user data escaped',back.weird.note === 'user data' && back.weird.__type === 'timestamp');
  ok('Date encodes as timestamp',  decodeValue(encodeValue(new Date('2026-01-02T03:04:05Z'))) instanceof Timestamp);
}

// ── the walk finds subcollections ────────────────────────────────────────────
// A fake just faithful enough to exercise listCollections() recursion, which
// is where the real risk is: subcollections are invisible to a naive export
// and that is where every contractor's customer list lives.
function fakeDb(tree) {
  // tree: { 'users': { 'u1': { _data:{...}, 'customers': { 'c1': {_data:{...}} } } } }
  function makeDoc(path, node) {
    const subs = Object.entries(node).filter(([k]) => k !== '_data');
    return {
      ref: {
        path,
        listCollections: async () => subs.map(([k, v]) => makeCol(`${path}/${k}`, v)),
      },
      data: () => node._data ?? {},
    };
  }
  function makeCol(path, node) {
    const docs = Object.entries(node).map(([k, v]) => makeDoc(`${path}/${k}`, v));
    return { path, get: async () => ({ docs, size: docs.length }) };
  }
  return { listCollections: async () => Object.entries(tree).map(([k, v]) => makeCol(k, v)) };
}

{
  const db = fakeDb({
    users: {
      u1: {
        _data: { plan: 'pro' },
        customers: { c1: { _data: { name: 'Ann' } }, c2: { _data: { name: 'Bo' } } },
        docCounts: { '2026-09': { _data: { count: 12 } } },
      },
      u2: { _data: { plan: 'essential' } },
    },
    publicDocs:      { d1: { _data: { amount: 750 } } },
    smsSuppressions: { '7137025744': { _data: { suppressed: true } } },
  });

  const snap = await exportDatabase(db);
  const paths = snap.docs.map(d => d.path).sort();

  ok('root docs captured',        paths.includes('users/u1') && paths.includes('publicDocs/d1'));
  ok('subcollection captured',    paths.includes('users/u1/customers/c1'));
  ok('both subcollection docs',   paths.includes('users/u1/customers/c2'));
  ok('second subcollection',      paths.includes('users/u1/docCounts/2026-09'));
  ok('top-level suppressions',    paths.includes('smsSuppressions/7137025744'));
  ok('doc count is total',        snap.docCount === 7);
  ok('collections listed',        snap.collections.includes('users/u1/customers'));
  ok('data preserved',            snap.docs.find(d => d.path === 'users/u1/customers/c1').data.name === 'Ann');
  ok('format version stamped',    snap.version === 1);
  ok('takenAt is ISO',            !Number.isNaN(Date.parse(snap.takenAt)));

  // Every path in the snapshot must be addressable by db.doc() on the way back:
  // an odd number of segments is a collection, not a document, and would throw
  // mid-restore after a partial write.
  ok('every path is a document',  snap.docs.every(d => d.path.split('/').length % 2 === 0));
}

{
  // A discovered collection with no documents must not crash the walk.
  const snap = await exportDatabase(fakeDb({ dispatch: {} }));
  ok('empty collection is fine',  snap.docCount === 0 && snap.collections.includes('dispatch'));
}

{
  // The doc ceiling must abort rather than silently store a partial backup.
  const many = {};
  for (let i = 0; i < 12; i++) many['d' + i] = { _data: { i } };
  let threw = false;
  try { await exportDatabase(fakeDb({ invoices: many }), { maxDocs: 5 }); }
  catch { threw = true; }
  ok('doc ceiling aborts loudly', threw);
}

// ── retention ────────────────────────────────────────────────────────────────
{
  const now = new Date('2026-09-09T07:00:00Z');
  const keys = [
    '2026-09-09.json', '2026-09-08.json',   // today, yesterday
    '2026-08-15.json',                      // 25 days old - inside daily window
    '2026-07-15.json',                      // 56 days old - out
    '2026-07-01.json',                      // monthly, within 12 months - keep
    '2026-01-01.json',                      // monthly, within 12 months - keep
    '2024-03-01.json',                      // monthly, older than 12 months - out
    'notes.txt',                            // unrecognised - never touch
  ];
  const del = keysToDelete(keys, { now });

  ok('keeps today',               !del.includes('2026-09-09.json'));
  ok('keeps inside daily window', !del.includes('2026-08-15.json'));
  ok('deletes old daily',          del.includes('2026-07-15.json'));
  ok('keeps recent monthly',      !del.includes('2026-07-01.json'));
  ok('keeps 12-month monthly',    !del.includes('2026-01-01.json'));
  ok('deletes ancient monthly',    del.includes('2024-03-01.json'));
  ok('ignores unknown keys',      !del.includes('notes.txt'));
  ok('deletes nothing else',       del.length === 2);
  ok('empty list is safe',         keysToDelete([], { now }).length === 0);
  ok('backupKey is YYYY-MM-DD',    backupKey(now) === '2026-09-09.json');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
