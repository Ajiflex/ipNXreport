'use strict';
// Distributed MongoDB lock — in-memory locks are useless across serverless
// instances. Expiry makes a crashed run self-heal.
const { col } = require('../mongodb');

async function acquireLock(name, ttlMs) {
  const c = await col('locks');
  await c.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {});
  const now = Date.now();
  const r = await c.findOneAndUpdate(
    { name, $or: [{ expiresAt: { $lt: new Date(now) } }, { expiresAt: { $exists: false } }] },
    { $set: { name, acquiredAt: new Date(now), expiresAt: new Date(now + ttlMs) } },
    { upsert: true, returnDocument: 'after' }
  );
  return !!(r && r.value);
}

async function releaseLock(name) {
  await (await col('locks')).deleteOne({ name });
}

module.exports = { acquireLock, releaseLock };
