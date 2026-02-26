// -----------------------------------------------------------------------------
// test/test-duplicate-title.js
//
// Mocha test suite verifying that when two it() blocks share the same title,
// only one of them runs and only one result is written to Redis.
//
// Run with: mocha test/test-duplicate-title.js
// -----------------------------------------------------------------------------
'use strict';

const assert = require('assert');
const Mocha = require('mocha/lib/mocha');
const Suite = require('mocha/lib/suite');
const Test = require('mocha/lib/test');

// -----------------------------------------------------------------------------
// Mock redis helpers
// -----------------------------------------------------------------------------
const redisResolved = require.resolve('redis');

// mockMulti simulates real Redis SET NX behaviour using an in-memory Map:
//   - First SET NX for a key stores the value and returns 'OK'
//   - Subsequent SET NX calls for the same key are no-ops and return null
//   - GET always returns the current owner
const mockMulti = (writtenResults, redisState) => () => {
  const cmds = [];
  const chain = {
    set: (...a) => { cmds.push(['set', ...a]); return chain; },
    get: (...a) => { cmds.push(['get', ...a]); return chain; },
    rPush: (...a) => {
      cmds.push(['rPush', ...a]);
      writtenResults.push(JSON.parse(a[1]));
      return chain;
    },
    expire: (...a) => { cmds.push(['expire', ...a]); return chain; },
    incr: (...a) => { cmds.push(['incr', ...a]); return chain; },
    exec: async () => {
      // beforeEach pipeline: SET NX + GET
      if (cmds[0] && cmds[0][0] === 'set') {
        const [, key, value] = cmds[0];
        const existing = redisState.get(key);
        if (existing === undefined) {
          redisState.set(key, value);   // SET NX succeeds
          return ['OK', value];
        }
        return [null, existing];        // SET NX fails, return existing owner
      }
      // afterEach pipeline: rPush + expire + incr + expire
      return [1, 1, 1, 1];
    }
  };
  return chain;
};

function injectMockRedis(writtenResults, redisState) {
  require.cache[redisResolved] = {
    id: redisResolved,
    filename: redisResolved,
    loaded: true,
    exports: {
      createClient: () => ({
        on: () => { },
        connect: async () => { },
        quit: async () => { },
        multi: mockMulti(writtenResults, redisState),
      })
    },
  };
}

function restoreRedis() {
  delete require.cache[redisResolved];
}

function loadFreshLib() {
  const libPath = require.resolve('../index.js');
  delete require.cache[libPath];
  return require('../index.js');
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
describe('mocha-distributed', function() {

  describe('duplicate title handling', function() {
    let writtenResults;
    let redisState;
    let lib;

    before(function() {
      writtenResults = [];
      redisState = new Map();
      injectMockRedis(writtenResults, redisState);

      process.env.MOCHA_DISTRIBUTED = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'test-exec-duplicate';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID = 'runner-test';

      lib = loadFreshLib();
    });

    after(function() {
      restoreRedis();
      delete require.cache[require.resolve('../index.js')];
    });

    it('runs only one of two tests with the same title', async function() {
      this.timeout(10000);

      // Build the inner mocha instance with two tests sharing the same title
      const m = new Mocha({ reporter: 'tap' });
      m.rootHooks(lib.mochaHooks);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'duplicate-suite');

      let runs = 0;
      suite.addTest(new Test('duplicate-title', function() { runs++; }));
      suite.addTest(new Test('duplicate-title', function() { runs++; }));

      const runner = await new Promise(resolve => m.run(resolve));

      assert.strictEqual(runs, 1,
        `expected 1 test body execution, got ${runs} (duplicate ran)`);

      assert.strictEqual(writtenResults.length, 1,
        `expected 1 result written to Redis, got ${writtenResults.length}`);

      // The second test should have been skipped (pending)
      // runner here is actually the stats object / exit code from m.run;
      // check pending via the suite's tests directly instead.
      const tests = suite.tests;
      const pendingTests = tests.filter(t => t.isPending && t.isPending());
      assert.strictEqual(pendingTests.length, 1,
        `expected 1 pending (skipped) test, got ${pendingTests.length}`);
    });
  });
});
