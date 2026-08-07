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
const Mocha  = require('mocha/lib/mocha');
const Suite  = require('mocha/lib/suite');
const Test   = require('mocha/lib/test');

// -----------------------------------------------------------------------------
// Mock redis helpers
// -----------------------------------------------------------------------------
const redisResolved = require.resolve('redis');

const mockMulti = (writtenResults, reportHash) => () => {
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
    sAdd:   (...a) => { cmds.push(['sAdd',   ...a]); return chain; },
    hSet:   (...a) => {
      cmds.push(['hSet', ...a]);
      reportHash.set(a[1], a[2]);
      return chain;
    },
    exec: async () => {
      // beforeEach pipeline: SET NX + GET (+ optional universe SADD/EXPIRE)
      if (cmds[0] && cmds[0][0] === 'set') {
        return [null, process.env.MOCHA_DISTRIBUTED_RUNNER_ID,
                ...cmds.slice(2).map(() => 1)];
      }
      // afterEach pipeline: rPush + expire + incr + expire (+ optional hSet/expire, sAdd/expire)
      return cmds.map(() => 1);
    }
  };
  return chain;
};

function injectMockRedis(writtenResults, reportHash) {
  require.cache[redisResolved] = {
    id:       redisResolved,
    filename: redisResolved,
    loaded:   true,
    exports:  {
      createClient: () => ({
        on:      () => {},
        connect: async () => {},
        quit:    async () => {},
        // Top-level ops used by mochaGlobalSetup / releaseClaimAndExit:
        // expected_total publication and runners_active bookkeeping.
        get:     async () => null,
        set:     async () => 'OK',
        incr:    async () => 1,
        decr:    async () => 0,
        expire:  async () => 1,
        del:     async () => 1,
        hGet:    async (key, field) => (reportHash.has(field) ? reportHash.get(field) : null),
        multi:   mockMulti(writtenResults, reportHash),
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
    let reportHash;
    let lib;

    before(function () {
      writtenResults = [];
      reportHash = new Map();
      injectMockRedis(writtenResults, reportHash);

      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'test-exec-retry';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-test';
      // This suite does not exercise drain — keep the old "exit after
      // local iteration" behaviour so teardown returns promptly.
      process.env.MOCHA_DISTRIBUTED_DRAIN_ENABLED = 'false';

      lib = loadFreshLib();
    });

    after(function () {
      restoreRedis();
      delete require.cache[require.resolve('../index.js')];
    });

    beforeEach(function () {
      writtenResults.length = 0;
      reportHash.clear();
    });

    it('records err, stdout and stderr on every retry attempt', async function () {
      this.timeout(10000);

      // Build the inner mocha instance with a flaky test that fails on
      // attempts 0 and 1, and passes on attempt 2
      const m = new Mocha({ reporter: 'min' });
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

    it('collapses a single-attempt passing test into one report entry', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.rootHooks(lib.mochaHooks);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'report-suite-single');
      suite.addTest(new Test('single-test', function () {}));

      await new Promise(resolve => m.run(resolve));

      assert.strictEqual(reportHash.size, 1, 'exactly one report entry');
      const [reportField, reportRaw] = Array.from(reportHash.entries())[0];
      const row = JSON.parse(reportRaw);
      assert.strictEqual(row.title, 'single-test');
      assert.strictEqual(row.state, 'passed');
      assert.strictEqual(row.attempts.length, 1, 'one attempt recorded');
      assert.strictEqual(row.attempts[0].retryAttempt, 0);

      // The test_result row must carry the exact reportKey used as the
      // report hash field, so a consumer can jump straight from one to the
      // other without recomputing the :dup-N suffix itself.
      assert.strictEqual(writtenResults[0].reportKey, reportField,
        'test_result.reportKey resolves directly to the report hash field');
      assert.strictEqual(row.reportKey, reportField,
        'the report row also carries its own key for HGETALL-only consumers');
    });

    it('collapses a retried test into one report entry with full attempt history', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.rootHooks(lib.mochaHooks);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'report-suite-retried');
      suite.retries(1);

      let attempt = 0;
      suite.addTest(new Test('retried-test', function () {
        attempt++;
        if (attempt === 1) throw new Error('fails on first attempt');
      }));

      await new Promise(resolve => m.run(resolve));

      // test_result still has one row per attempt...
      assert.strictEqual(writtenResults.length, 2, '2 test_result rows (one per attempt)');

      // ...but report collapses them into a single entry.
      assert.strictEqual(reportHash.size, 1, 'exactly one report entry');
      const [reportField, reportRaw] = Array.from(reportHash.entries())[0];
      const row = JSON.parse(reportRaw);

      assert.strictEqual(row.title, 'retried-test');
      assert.strictEqual(row.retryTotal, 1);
      assert.strictEqual(row.retryAttempt, undefined, 'no retryAttempt at top level');

      // Every attempt's test_result row must point at the SAME reportKey,
      // matching the actual report hash field, regardless of which attempt.
      for (const r of writtenResults) {
        assert.strictEqual(r.reportKey, reportField,
          `attempt ${r.retryAttempt}: test_result.reportKey resolves to the report hash field`);
      }
      assert.strictEqual(row.reportKey, reportField);

      // Top-level fields reflect the FINAL (passing) attempt.
      assert.strictEqual(row.state, 'passed');
      assert.strictEqual(row.failed, false);
      assert.strictEqual(row.err, null);

      // startTime is anchored at the FIRST attempt, not the final one.
      const sortedResults = writtenResults.slice().sort((a, b) => a.retryAttempt - b.retryAttempt);
      assert.strictEqual(row.startTime, sortedResults[0].startTime, 'startTime = first attempt');
      assert.strictEqual(row.endTime, sortedResults[1].endTime, 'endTime = final attempt');

      // Attempt history preserves both attempts, with retryAttempt per entry.
      assert.strictEqual(row.attempts.length, 2, 'both attempts recorded');
      assert.strictEqual(row.attempts[0].retryAttempt, 0);
      assert.strictEqual(row.attempts[0].state, 'failed');
      assert.ok(row.attempts[0].err && row.attempts[0].err.message.includes('fails on first attempt'));
      assert.strictEqual(row.attempts[1].retryAttempt, 1);
      assert.strictEqual(row.attempts[1].state, 'passed');
    });
  });
});
