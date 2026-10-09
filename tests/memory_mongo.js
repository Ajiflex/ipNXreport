'use strict';
// In-memory Mongo adapter — implements exactly the driver surface the server
// uses, so server/mongodb (and everything above it) executes during tests
// without a real MongoDB deployment.
//
// Supported: find/filter operators ($in, $gte, $lte, $lt, $gt, $ne, $exists,
// $or, equality incl. Date comparison), $set updates, upserts, bulk ops,
// findOneAndUpdate, createIndex(es) (no-op), cursors (toArray/project/sort/limit).
let oid = 0;
const nextId = () => 'mem_' + (++oid) + '_' + Date.now();

const val = v => (v instanceof Date ? v.getTime() : v);
const isPlainOp = c => c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c) &&
  Object.keys(c).some(k => k.startsWith('$'));

function eqVal(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  return a === b;
}

function matchCondition(docVal, cond) {
  if (isPlainOp(cond)) {
    for (const op of Object.keys(cond)) {
      const c = cond[op];
      if (op === '$in') {
        if (!c.some(x => eqVal(docVal, x) || (x === null && docVal === undefined))) return false;
      } else if (op === '$gte') { if (!(val(docVal) >= val(c))) return false; }
      else if (op === '$lte') { if (!(val(docVal) <= val(c))) return false; }
      else if (op === '$lt') { if (!(val(docVal) < val(c))) return false; }
      else if (op === '$gt') { if (!(val(docVal) > val(c))) return false; }
      else if (op === '$ne') { if (eqVal(docVal, c)) return false; }
      else if (op === '$exists') { if ((docVal !== undefined) !== !!c) return false; }
      else throw new Error('memory-mongo: unsupported operator ' + op);
    }
    return true;
  }
  return eqVal(docVal, cond);
}

function matches(doc, filter) {
  for (const key of Object.keys(filter || {})) {
    if (key === '$or') {
      if (!filter.$or.some(sub => matches(doc, sub))) return false;
      continue;
    }
    if (key === '$and') {
      if (!filter.$and.every(sub => matches(doc, sub))) return false;
      continue;
    }
    if (!matchCondition(doc[key], filter[key])) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  for (const op of Object.keys(update)) {
    if (op === '$set') Object.assign(doc, update.$set);
    else if (op === '$unset') for (const k of Object.keys(update.$unset)) delete doc[k];
    else throw new Error('memory-mongo: unsupported update operator ' + op);
  }
}

// Scalar equality fields of a filter become the base document on upsert.
function baseFromFilter(filter) {
  const base = {};
  for (const [k, v] of Object.entries(filter || {})) {
    if (k.startsWith('$')) continue;
    if (!isPlainOp(v)) base[k] = v;
  }
  return base;
}

class MemCursor {
  constructor(docs) { this._docs = docs; }
  project(spec) {
    const exclusions = Object.keys(spec || {}).filter(k => spec[k] === 0);
    if (exclusions.length) {
      this._docs = this._docs.map(d => {
        const c = { ...d };
        exclusions.forEach(k => delete c[k]);
        return c;
      });
    }
    return this;
  }
  sort(spec) {
    const [[field, dir]] = Object.entries(spec || {});
    this._docs = this._docs.slice().sort((a, b) => (val(a[field]) - val(b[field])) * (dir === -1 ? -1 : 1));
    return this;
  }
  limit(n) { this._docs = this._docs.slice(0, n); return this; }
  async toArray() { return this._docs.map(d => ({ ...d })); }
}

class MemCollection {
  constructor(name) { this.name = name; this._docs = []; }
  _match(filter) { return this._docs.filter(d => matches(d, filter)); }
  find(filter) { return new MemCursor(this._match(filter)); }
  async findOne(filter) { const m = this._match(filter)[0]; return m ? { ...m } : null; }
  async insertOne(doc) {
    const d = { ...doc };
    if (d._id === undefined) d._id = nextId();
    this._docs.push(d);
    return { acknowledged: true, insertedId: d._id };
  }
  async insertMany(docs) {
    const ids = [];
    for (const d of docs) ids.push((await this.insertOne(d)).insertedId);
    return { acknowledged: true, insertedCount: ids.length, insertedIds: ids };
  }
  async updateOne(filter, update, opts) {
    const doc = this._match(filter)[0];
    if (doc) {
      applyUpdate(doc, update);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    }
    if (opts && opts.upsert) {
      const d = { ...baseFromFilter(filter), _id: nextId() };
      applyUpdate(d, update);
      this._docs.push(d);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: d._id };
    }
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }
  async updateMany(filter, update) {
    const docs = this._match(filter);
    docs.forEach(d => applyUpdate(d, update));
    return { acknowledged: true, matchedCount: docs.length, modifiedCount: docs.length };
  }
  async deleteOne(filter) {
    const i = this._docs.findIndex(d => matches(d, filter));
    if (i >= 0) { this._docs.splice(i, 1); return { acknowledged: true, deletedCount: 1 }; }
    return { acknowledged: true, deletedCount: 0 };
  }
  async deleteMany(filter) {
    const before = this._docs.length;
    this._docs = this._docs.filter(d => !matches(d, filter));
    return { acknowledged: true, deletedCount: before - this._docs.length };
  }
  async findOneAndUpdate(filter, update, opts) {
    const doc = this._match(filter)[0];
    if (doc) {
      applyUpdate(doc, update);
      return { value: { ...doc }, ok: 1 };
    }
    if (opts && opts.upsert) {
      // Emulate the unique-index collision the real driver would hit when an
      // unexpired doc with the same scalar key exists but fails the full filter
      // (lock held by another run): no insert, no acquisition.
      const base = baseFromFilter(filter);
      const clash = Object.keys(base).length &&
        this._docs.some(d => Object.keys(base).every(k => eqVal(d[k], base[k])));
      if (clash) return { value: null, ok: 1 };
      const d = { ...base, _id: nextId() };
      applyUpdate(d, update);
      this._docs.push(d);
      return { value: { ...d }, ok: 1 };
    }
    return { value: null, ok: 1 };
  }
  async createIndex() { return 'ok'; }
  async createIndexes() { return ['ok']; }
  initializeUnorderedBulkOp() {
    const self = this;
    const ops = [];
    return {
      find(filter) {
        return { updateOne(update) { ops.push({ type: 'updateOne', filter, update }); } };
      },
      insert(doc) { ops.push({ type: 'insert', doc }); },
      async execute() {
        let inserted = 0, modified = 0;
        for (const op of ops) {
          if (op.type === 'insert') { await self.insertOne(op.doc); inserted++; }
          else { const r = await self.updateOne(op.filter, op.update); modified += r.modifiedCount; }
        }
        return { insertedCount: inserted, modifiedCount: modified, ok: 1 };
      }
    };
  }
}

class MemDb {
  constructor() { this._collections = new Map(); }
  collection(name) {
    if (!this._collections.has(name)) this._collections.set(name, new MemCollection(name));
    return this._collections.get(name);
  }
}

function createMemoryMongo() {
  return { client: null, db: new MemDb() };
}

module.exports = { createMemoryMongo };
