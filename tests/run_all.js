'use strict';
// Test entry point. Sets the test environment, loads every suite, runs them.
// Run: NODE_PATH=<deps>/node_modules npm test
const { setupEnv, run } = require('./helpers');

setupEnv(); // before any server module reads config

require('./regression_hash_rowcount.test');
require('./regression_duplicate_authority.test');
require('./ingestion.test');
require('./reconciliation.test');
require('./pop.test');
require('./xlsx.test');
require('./reporting.test');
require('./autonomous.test');
require('./api.test');

run().then(({ fail }) => process.exit(fail ? 1 : 0))
  .catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
