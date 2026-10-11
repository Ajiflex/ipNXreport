'use strict';
// Distributed MongoDB lock — in-memory locks are useless across serverless
// instances. Expiry makes a crashed run self-heal.
//
// Lock-acquisition contract (E11000 fix):
//   • NEVER upsert against { name, expiry... } — when a live lock already
//     exists the upsert filter matches nothing and Mongo attempts an INSERT,
//     which collides with the unique name_1 index → E11000 surfaced as a sync
//     FAILURE. Instead: take over an expired lock in place, otherwise INSERT;
//     any duplicate-key error means "someone else holds (or is racing for)
//     the lock" → lock conflict, never an unhandled exception.
//   • Driver-version tolerant: mongodb v6 returns the document directly from
//     findOneAndUpdate; older drivers return { value }. unwrap() accepts both.
const { col } = require('../mongodb');

function unwrap(r) {
  if (!r) return null;
  return r.value !== undefined ? r.value : r;
}

function isDuplicateKey(e) {
  return !!e && (e.code === 11000 || /E11000|duplicate key/i.test(String(e.message || e)));
}

async function acquireLock(name, ttlMs) {
  const c = await col('locks');
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  const now = Date.now();
  const acquiredAt = new Date(now);
  const expiresAt = new Date(now + ttlMs);
  try {
    // 1) Take over an EXPIRED (or legacy field-less) lock in place — no insert.
    const taken = unwrap(await c.findOneAndUpdate(
      { name, $or: [{ expiresAt: { $lt: new Date(now) } }, { expiresAt: { $exists: false } }] },
      { $set: { name, acquiredAt, expiresAt } },
      { returnDocument: 'after' }
    ));
    if (taken) return true;
    // 2) No document at all → create it. A duplicate key here is a lock
    //    conflict (concurrent holder or racing acquirer), not a crash.
    try {
      await c.insertOne({ name, acquiredAt, expiresAt, createdAt: acquiredAt });
      return true;
    } catch (e) {
      if (isDuplicateKey(e)) return false;
      throw e;
    }
  } catch (e) {
    if (isDuplicateKey(e)) return false; // upsert-style race safety net
    throw e;
  }
}

async function releaseLock(name) {
  await (await col('locks')).deleteOne({ name });
}

module.exports = { acquireLock, releaseLock };
