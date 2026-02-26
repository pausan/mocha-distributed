// -----------------------------------------------------------------------------
// test/test-retry.js
//
// Mocha test suite verifying that mocha-distributed records err, stdout and
// stderr on ALL retry attempts, not just the last one.
//
// Run with: mocha test/test-retry.js
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

const mockMulti = (writtenResults, redisState) => () => {
  const cmds = [];
  const chain = {
    set:    (...a) => { cmds.push(['set',    ...a]); return chain; },
    get:    (...a) => { cmds.push(['get',    ...a]); return chain; },
    rPush:  (...a) => {
      cmds.push(['rPush', ...a]);
      writtenResults.push(JSON.parse(a[1]));
      return chain;
    },
    expire: (...a) => { cmds.push(['expire', ...a]); return chain; },
    incr:   (...a) => { cmds.push(['incr',   ...a]); return chain; },
    exec: async () => {
      // beforeEach pipeline: SET NX + GET — simulate real Redis NX behaviour
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
    id:       redisResolved,
    filename: redisResolved,
    loaded:   true,
    exports:  {
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
describe('mocha-distributed', function () {

  describe('retry attempt recording', function () {
    let writtenResults;
    let redisState;
    let lib;

    before(function () {
      writtenResults = [];
      redisState = new Map();
      injectMockRedis(writtenResults, redisState);

      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'test-exec-retry';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-test';

      lib = loadFreshLib();
    });

    after(function () {
      restoreRedis();
      delete require.cache[require.resolve('../index.js')];
    });

    it('records err, stdout and stderr on every retry attempt', async function () {
      this.timeout(10000);

      // Build the inner mocha instance with a flaky test that fails on
      // attempts 0 and 1, and passes on attempt 2
      const m = new Mocha({ reporter: 'tap' });
      m.rootHooks(lib.mochaHooks);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'retry-suite');
      suite.retries(2);

      let attempt = 0;
      suite.addTest(new Test('flaky-test', function () {
        attempt++;
        console.log('stdout from attempt ' + attempt);
        console.error('stderr from attempt ' + attempt);
        if (attempt < 3) throw new Error('intentional failure on attempt ' + attempt);
      }));

      await new Promise(resolve => m.run(resolve));

      // Sort by retryAttempt for stable assertions
      const results = writtenResults.slice().sort((a, b) => a.retryAttempt - b.retryAttempt);

      assert.strictEqual(results.length, 3, '3 results written to Redis (one per attempt)');

      // Attempts 0 and 1: failed, err populated, stdout and stderr present
      for (const i of [0, 1]) {
        const r = results[i];
        assert.strictEqual(r.retryAttempt, i,             `attempt ${i}: retryAttempt`);
        assert.strictEqual(r.state, 'failed',             `attempt ${i}: state`);
        assert.ok(r.err && r.err.message,                 `attempt ${i}: err.message should be set`);
        assert.ok(r.stdout.includes(`attempt ${i + 1}`), `attempt ${i}: stdout`);
        assert.ok(r.stderr.includes(`attempt ${i + 1}`), `attempt ${i}: stderr`);
      }

      // Attempt 2: passed, stdout and stderr present
      const r2 = results[2];
      assert.strictEqual(r2.retryAttempt, 2,    'attempt 2: retryAttempt');
      assert.strictEqual(r2.state, 'passed',     'attempt 2: state');
      assert.ok(r2.stdout.includes('attempt 3'), 'attempt 2: stdout');
      assert.ok(r2.stderr.includes('attempt 3'), 'attempt 2: stderr');
    });
  });
});
