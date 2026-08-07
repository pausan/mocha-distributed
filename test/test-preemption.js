// -----------------------------------------------------------------------------
// test/test-preemption.js
//
// Verifies the preemption-resilience behaviour:
//   1. beforeEach claim uses MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME (short).
//   2. afterEach promotes the claim key to MOCHA_DISTRIBUTED_EXPIRATION_TIME
//      (long, the result-list lifetime) as a tombstone.
//   3. When another runner owns the claim the test is skipped and no
//      tombstone is written.
//   4. While a test runs the keepalive refreshes the claim TTL.
//   5. SIGTERM releases the in-flight claim with DEL when we own it.
// -----------------------------------------------------------------------------
'use strict';

const assert = require('assert');
const Mocha  = require('mocha/lib/mocha');
const Suite  = require('mocha/lib/suite');
const Test   = require('mocha/lib/test');

// -----------------------------------------------------------------------------
// Mock redis client that records every call
// -----------------------------------------------------------------------------
const redisResolved = require.resolve('redis');

function makeMockClient(opts = {}) {
  const claimOwners = opts.claimOwners || {}; // testKey -> existing owner
  // Keys in this set behave as if their runner already died: EXISTS returns
  // 0 and top-level GET returns null even if multi().set() would normally
  // persist a value. Simulates an in-flight claim whose owner was
  // preempted before writing done_tests.
  const preemptedKeys = new Set(opts.preemptedKeys || []);
  const kv = new Map();                       // shared in-memory kv store
  const calls = [];
  const client = {
    calls,
    kv,
    on:      () => {},
    connect: async () => {},
    quit:    async () => { calls.push(['quit']); },
    expire:  async (k, ttl) => { calls.push(['expire', k, ttl]); return 1; },
    get:     async (k) => {
      calls.push(['get', k]);
      if (kv.has(k)) return kv.get(k);
      if (claimOwners[k]) return claimOwners[k];
      return null;
    },
    set:     async (k, v /*, opts */) => {
      calls.push(['set', k, v]);
      kv.set(k, String(v));
      return 'OK';
    },
    incr:    async (k) => {
      calls.push(['incr', k]);
      const n = (parseInt(kv.get(k) || '0', 10) || 0) + 1;
      kv.set(k, String(n));
      return n;
    },
    decr:    async (k) => {
      calls.push(['decr', k]);
      const n = (parseInt(kv.get(k) || '0', 10) || 0) - 1;
      kv.set(k, String(n));
      return n;
    },
    del:     async (k) => { calls.push(['del', k]); return 1; },
    // Set primitives used by the drain phase. Backed by a per-set Map
    // inside kv (stored as JSON so it round-trips through the string API).
    sAdd:    async (k, ...members) => {
      calls.push(['sAdd', k, ...members]);
      const existing = kv.has(k) ? new Set(JSON.parse(kv.get(k))) : new Set();
      for (const m of members.flat()) existing.add(m);
      kv.set(k, JSON.stringify([...existing]));
      return members.flat().length;
    },
    sMembers: async (k) => {
      calls.push(['sMembers', k]);
      return kv.has(k) ? JSON.parse(kv.get(k)) : [];
    },
    sCard:   async (k) => {
      calls.push(['sCard', k]);
      return kv.has(k) ? JSON.parse(kv.get(k)).length : 0;
    },
    sDiff:   async (keys) => {
      calls.push(['sDiff', keys]);
      const arr = Array.isArray(keys) ? keys : [keys];
      const first = kv.has(arr[0]) ? new Set(JSON.parse(kv.get(arr[0]))) : new Set();
      for (let i = 1; i < arr.length; i++) {
        const other = kv.has(arr[i]) ? new Set(JSON.parse(kv.get(arr[i]))) : new Set();
        for (const m of other) first.delete(m);
      }
      return [...first];
    },
    exists:  async (k) => {
      calls.push(['exists', k]);
      if (preemptedKeys.has(k)) return 0;
      return kv.has(k) ? 1 : 0;
    },
    // Hash primitive backing the collapsed `report` key. Stored as a JSON
    // object under the hash's own kv entry, mirroring the sAdd/sMembers
    // JSON-in-kv convention already used above for sets.
    hGet:    async (k, field) => {
      calls.push(['hGet', k, field]);
      const obj = kv.has(k) ? JSON.parse(kv.get(k)) : {};
      return Object.prototype.hasOwnProperty.call(obj, field) ? obj[field] : null;
    },
    multi:   () => {
      const cmds = [];
      const chain = {
        set:    (...a) => { cmds.push(['set',    ...a]); return chain; },
        get:    (...a) => { cmds.push(['get',    ...a]); return chain; },
        rPush:  (...a) => { cmds.push(['rPush',  ...a]); return chain; },
        expire: (...a) => { cmds.push(['expire', ...a]); return chain; },
        incr:   (...a) => { cmds.push(['incr',   ...a]); return chain; },
        sAdd:   (...a) => { cmds.push(['sAdd',   ...a]); return chain; },
        exists: (...a) => { cmds.push(['exists', ...a]); return chain; },
        hSet:   (...a) => { cmds.push(['hSet',   ...a]); return chain; },
        exec: async () => {
          calls.push(['multi', cmds.slice()]);
          // beforeEach pipeline: SET NX + GET (+ sAdd/expire on universe).
          // Persist the SET into the kv store so later top-level GETs
          // (e.g. the SIGTERM ownership check) see the correct owner.
          if (cmds[0] && cmds[0][0] === 'set') {
            const testKey = cmds[0][1];
            const owner = claimOwners[testKey] ||
                          process.env.MOCHA_DISTRIBUTED_RUNNER_ID;
            // Preempted keys stay unclaimable so drain can observe them as
            // orphans: the SET NX 'succeeds' from the caller's perspective
            // but no live claim key is stored (and EXISTS returns 0).
            if (!preemptedKeys.has(testKey) && !kv.has(testKey)) {
              kv.set(testKey, owner);
            }
            // Apply any sAdd commands piggybacked on the same pipeline so
            // the shared state (test_universe) reflects them for later
            // drain-phase reads.
            for (const cmd of cmds) {
              if (cmd[0] === 'sAdd') {
                const [, sk, ...members] = cmd;
                const existing = kv.has(sk) ? new Set(JSON.parse(kv.get(sk))) : new Set();
                for (const m of members.flat()) existing.add(m);
                kv.set(sk, JSON.stringify([...existing]));
              }
            }
            return [null, owner, ...cmds.slice(2).map(() => 1)];
          }
          // afterEach / drain pipelines: apply sAdd and exists to shared
          // state so drain iterations converge correctly against the mock.
          const results = [];
          for (const cmd of cmds) {
            if (cmd[0] === 'sAdd') {
              const [, sk, ...members] = cmd;
              const existing = kv.has(sk) ? new Set(JSON.parse(kv.get(sk))) : new Set();
              for (const m of members.flat()) existing.add(m);
              kv.set(sk, JSON.stringify([...existing]));
              results.push(members.flat().length);
            } else if (cmd[0] === 'exists') {
              results.push(kv.has(cmd[1]) ? 1 : 0);
            } else if (cmd[0] === 'hSet') {
              const [, hk, field, value] = cmd;
              const obj = kv.has(hk) ? JSON.parse(kv.get(hk)) : {};
              obj[field] = value;
              kv.set(hk, JSON.stringify(obj));
              results.push(1);
            } else {
              results.push(1);
            }
          }
          return results;
        }
      };
      return chain;
    }
  };
  return client;
}

function injectMockRedis(client) {
  require.cache[redisResolved] = {
    id:       redisResolved,
    filename: redisResolved,
    loaded:   true,
    exports:  { createClient: () => client },
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

function clearLib() {
  delete require.cache[require.resolve('../index.js')];
  // The lib registers SIGTERM/SIGINT listeners on load; remove ours so
  // each describe starts fresh and the outer test process is not affected.
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  // Also scrub drain-related env vars so a leak from one describe (which
  // may have set MOCHA_DISTRIBUTED_DRAIN_ENABLED='false') doesn't silently
  // disable drain in a later describe that expects the default.
  delete process.env.MOCHA_DISTRIBUTED_DRAIN_ENABLED;
  delete process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT;
  delete process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL;
  delete process.env.MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE;
}

function findSetCmd(calls) {
  for (const c of calls) {
    if (c[0] !== 'multi') continue;
    const set = c[1].find(cmd => cmd[0] === 'set');
    if (set) return set;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
const LONG_TTL  = `${7 * 24 * 3600}`;
const SHORT_TTL = `${10 * 60}`;

describe('mocha-distributed preemption resilience', function () {

  // ---------------------------------------------------------------------------
  describe('claim TTL split + tombstone on completion', function () {
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-ttl';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-ttl';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('SETs claim with short TTL and tombstones with long TTL', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'ttl-suite');
      suite.addTest(new Test('passes', function () {}));

      await new Promise(resolve => m.run(resolve));

      const setCmd = findSetCmd(client.calls);
      assert.ok(setCmd, 'SET NX was recorded');
      const [, testKey, runnerId, setOpts] = setCmd;
      assert.strictEqual(runnerId, 'runner-ttl');
      assert.strictEqual(setOpts.NX, true, 'SET NX flag set');
      assert.strictEqual(String(setOpts.EX), SHORT_TTL,
        'claim TTL is the short value (default 600s)');

      // Tombstone: a direct (non-multi) expire on the claim key with the
      // long TTL must have been called after the test completed.
      const tombstone = client.calls.find(c =>
        c[0] === 'expire' && c[1] === testKey && String(c[2]) === LONG_TTL
      );
      assert.ok(tombstone,
        'claim key promoted to long-TTL tombstone after completion');
    });
  });

  // ---------------------------------------------------------------------------
  describe('honours MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME override', function () {
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-override';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-override';
      process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME = '120';
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () {
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      restoreRedis();
      clearLib();
    });

    it('SETs claim with the configured short TTL', async function () {
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);
      const suite = Suite.create(m.suite, 'override-suite');
      suite.addTest(new Test('passes', function () {}));
      await new Promise(resolve => m.run(resolve));

      const setCmd = findSetCmd(client.calls);
      assert.ok(setCmd);
      assert.strictEqual(String(setCmd[3].EX), '120',
        'claim TTL honours env override');
    });
  });

  // ---------------------------------------------------------------------------
  describe('skipped test (claim already owned)', function () {
    let client, lib;

    before(function () {
      // Pre-populate the claim owner so the runner SET+GET returns a foreign id
      client = makeMockClient({
        // any key in the execution will be owned by "other-runner"
        // (matched in mock by env var fallback OR explicit map; we just
        // ignore the runner id env and force a different owner via a Proxy)
      });
      // Wrap multi exec to always return a different runner id
      const realMulti = client.multi;
      client.multi = () => {
        const chain = realMulti();
        const realExec = chain.exec;
        chain.exec = async function () {
          const result = await realExec();
          // beforeEach pipeline: replace assignedRunnerId with foreign id.
          // Detect it by the shape: SET NX returns null and GET returns a
          // string runner id, whereas afterEach returns only integers.
          if (Array.isArray(result) && result[0] === null &&
              typeof result[1] === 'string') {
            result[1] = 'other-runner';
            return result;
          }
          return result;
        };
        return chain;
      };
      injectMockRedis(client);

      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-skip';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-skip';
      // Drain cannot converge in this mock (test is owned by another
      // runner, done_tests stays empty). Disable drain for this suite;
      // dedicated drain tests exercise the loop separately.
      process.env.MOCHA_DISTRIBUTED_DRAIN_ENABLED = 'false';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('does not write a tombstone when another runner owns the claim', async function () {
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);
      const suite = Suite.create(m.suite, 'skip-suite');
      let testRan = false;
      suite.addTest(new Test('skipped', function () { testRan = true; }));
      await new Promise(resolve => m.run(resolve));

      assert.strictEqual(testRan, false, 'test body did not execute (skipped)');

      const setCmd = findSetCmd(client.calls);
      assert.ok(setCmd, 'SET NX still attempted');
      const testKey = setCmd[1];

      const tombstone = client.calls.find(c =>
        c[0] === 'expire' && c[1] === testKey && String(c[2]) === LONG_TTL
      );
      assert.strictEqual(tombstone, undefined,
        'no tombstone written for a claim owned by another runner');

      // No rPush either (skipped tests don't write a result row).
      const resultWrite = client.calls.find(c =>
        c[0] === 'multi' && c[1].some(cmd => cmd[0] === 'rPush')
      );
      assert.strictEqual(resultWrite, undefined,
        'no result row written for a skipped test');
    });
  });

  // ---------------------------------------------------------------------------
  describe('keepalive refresh during a running test', function () {
    let client, lib;
    let realSetInterval, capturedInterval;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);

      realSetInterval = global.setInterval;
      capturedInterval = null;
      global.setInterval = function (fn, ms) {
        capturedInterval = { fn, ms };
        // Return a real (but inert) timer handle so clearInterval works.
        return realSetInterval(() => {}, 1 << 30);
      };

      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-keepalive';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-keepalive';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () {
      global.setInterval = realSetInterval;
      restoreRedis();
      clearLib();
    });

    it('refreshes the claim with the short TTL while the test runs', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'keepalive-suite');
      suite.addTest(new Test('long-running', async function () {
        // beforeEach has registered the keepalive by now; fire it twice
        // to simulate the interval firing while the test runs.
        assert.ok(capturedInterval, 'keepalive setInterval was registered');
        capturedInterval.fn();
        capturedInterval.fn();
        // Let the awaited expire() promises resolve.
        await new Promise(r => setImmediate(r));
      }));

      // Snapshot calls made before mocha runs the test.
      const callsBefore = client.calls.length;
      await new Promise(resolve => m.run(resolve));

      const setCmd = findSetCmd(client.calls);
      const testKey = setCmd[1];

      // The interval interval value must be claim_ttl/3 in seconds = 200s
      // for the default 600s TTL. Allow >= 30s floor, default => 200000ms.
      assert.strictEqual(capturedInterval.ms, 200 * 1000,
        'keepalive interval is claim_ttl/3 seconds');

      // Two refresh calls with the short TTL must have been recorded.
      const refreshes = client.calls
        .slice(callsBefore)
        .filter(c => c[0] === 'expire' && c[1] === testKey
                     && String(c[2]) === SHORT_TTL);
      assert.ok(refreshes.length >= 2,
        `>=2 keepalive refreshes recorded (got ${refreshes.length})`);
    });
  });

  // ---------------------------------------------------------------------------
  describe('SIGTERM releases the in-flight claim', function () {
    let client, lib;
    let realExit;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-sigterm';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-sigterm';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;

      // The lib calls process.exit at the end of the SIGTERM handler;
      // stub it so we don't kill the outer mocha runner.
      realExit = process.exit;
      process.exit = function () { /* no-op for tests */ };

      lib = loadFreshLib();
    });

    after(function () {
      process.exit = realExit;
      restoreRedis();
      clearLib();
    });

    it('DELs the claim key when this runner owns it', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'sigterm-suite');
      let testKeyAtSigterm = null;
      suite.addTest(new Test('preempted', async function () {
        // Grab the lib's SIGTERM listener (the most recently installed one)
        // and invoke it directly. The lib registers it as
        //   () => releaseClaimAndExit("SIGTERM")
        // which returns the promise, so we can await it.
        const listeners = process.listeners('SIGTERM');
        assert.ok(listeners.length > 0, 'SIGTERM listener installed');
        // Capture the claim key from the most recent SET in the mock.
        const setCmd = findSetCmd(client.calls);
        testKeyAtSigterm = setCmd && setCmd[1];
        await listeners[listeners.length - 1]();
      }));

      await new Promise(resolve => m.run(resolve));

      assert.ok(testKeyAtSigterm, 'claim key was set before SIGTERM');
      const del = client.calls.find(c =>
        c[0] === 'del' && c[1] === testKeyAtSigterm
      );
      assert.ok(del, 'SIGTERM handler DELd the in-flight claim key');
    });
  });

  // ---------------------------------------------------------------------------
  describe('pre-walk key stability (dup-N + serial collapse)', function () {
    // The pre-walk assigns each test its canonical key (with :dup-N suffix
    // for duplicated titles, and a collapsed [serial-x] key for serial
    // tests) before any test runs. This test asserts that the SET NX calls
    // observed by redis match the deterministic keys produced by the walk.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-keys';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-keys';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('assigns :dup-N suffixes and collapses serial keys as expected', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      // Two duplicated titles + a serial group of three tests.
      const suite = Suite.create(m.suite, 'keys-suite');
      suite.addTest(new Test('dup-title', function () {}));
      suite.addTest(new Test('dup-title', function () {}));
      suite.addTest(new Test('dup-title', function () {}));
      suite.addTest(new Test('serial-1 [serial-group-a]', function () {}));
      suite.addTest(new Test('serial-2 [serial-group-a]', function () {}));
      suite.addTest(new Test('serial-3 [serial-group-a]', function () {}));

      await new Promise(resolve => m.run(resolve));

      // Collect the keys used in every SET NX call in order.
      const setKeys = client.calls
        .filter(c => c[0] === 'multi')
        .map(c => c[1].find(cmd => cmd[0] === 'set'))
        .filter(Boolean)
        .map(cmd => cmd[1]);

      const execId = 'pre-exec-keys';
      // Duplicated titles must get consecutive :dup-N suffixes on the same
      // base key. Order matches suite registration order (DFS in the walk).
      assert.deepStrictEqual(setKeys.slice(0, 3), [
        `${execId}:keys-suite:dup-title:dup-1`,
        `${execId}:keys-suite:dup-title:dup-2`,
        `${execId}:keys-suite:dup-title:dup-3`,
      ], 'duplicated titles get stable :dup-N suffixes from the pre-walk');

      // All three serial tests must collapse to the same claim key derived
      // from the [serial-group-a] substring — no dup suffix, no per-test
      // uniqueness. This is what makes the whole group run on one runner.
      const serialKey = `${execId}:[serial-group-a]`;
      assert.deepStrictEqual(setKeys.slice(3, 6),
        [serialKey, serialKey, serialKey],
        'serial-group tests share one collapsed claim key');
    });
  });

  // ---------------------------------------------------------------------------
  describe('collapsed report entries for serial-group siblings', function () {
    // Serial-group members share ONE collapsed claim key (proven above), but
    // each is a distinct logical test. `report` must key on something other
    // than the claim key, or every sibling but the last would silently
    // overwrite its group-mates' entry.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'report-serial-exec';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-report-serial';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('gives each serial-group sibling its own report entry instead of collapsing them together', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'serial-report-suite');
      suite.addTest(new Test('serial-a [serial-report-group]', function () {}));
      suite.addTest(new Test('serial-b [serial-report-group]', function () {}));
      suite.addTest(new Test('serial-c [serial-report-group]', function () {}));

      await new Promise(resolve => m.run(resolve));

      const execId = 'report-serial-exec';
      const reportHashRaw = client.kv.get(`${execId}:report`);
      assert.ok(reportHashRaw, 'report hash exists');
      const reportHash = JSON.parse(reportHashRaw);

      assert.strictEqual(Object.keys(reportHash).length, 3,
        'three distinct report entries, one per serial-group sibling');

      const titles = Object.values(reportHash).map(v => JSON.parse(v).title).sort();
      assert.deepStrictEqual(titles, [
        'serial-a [serial-report-group]',
        'serial-b [serial-report-group]',
        'serial-c [serial-report-group]',
      ], 'each sibling kept its own title — none overwrote another');
    });
  });

  // ---------------------------------------------------------------------------
  describe('test_universe + done_tests bookkeeping', function () {
    // The drain phase relies on two sets in redis:
    //   test_universe : every test key that has been attempted anywhere.
    //   done_tests    : every test key that has been fully accounted for.
    // Serial groups collapse to one claim key; they should be marked done
    // only when the last test in the group finishes, otherwise a drain-phase
    // peer could conclude the group is complete mid-run.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-sets';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-sets';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('SADDs every attempt to test_universe and marks done_tests correctly', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'sets-suite');
      suite.addTest(new Test('plain', function () {}));
      suite.addTest(new Test('s1 [serial-g]', function () {}));
      suite.addTest(new Test('s2 [serial-g]', function () {}));
      suite.addTest(new Test('s3 [serial-g]', function () {}));

      await new Promise(resolve => m.run(resolve));

      const execId = 'pre-exec-sets';
      const universeKey = `${execId}:test_universe`;
      const doneKey     = `${execId}:done_tests`;

      // Collect all sAdd commands across every beforeEach/afterEach pipeline
      // observed -- this excludes the separate prepopulation pipeline that
      // globalSetup fires once, upfront (identifiable as a multi pipeline
      // whose first command is itself 'sAdd', carrying the whole key set as
      // a single array member rather than one key per attempt).
      const sAdds = [];
      for (const c of client.calls) {
        if (c[0] !== 'multi' || (c[1][0] && c[1][0][0] === 'sAdd')) continue;
        for (const cmd of c[1]) {
          if (cmd[0] === 'sAdd') sAdds.push({ key: cmd[1], member: cmd[2] });
        }
      }

      const universeAdds = sAdds.filter(x => x.key === universeKey).map(x => x.member);
      const doneAdds     = sAdds.filter(x => x.key === doneKey    ).map(x => x.member);

      // Every beforeEach contributes one universe member: 4 attempts (1 plain
      // + 3 serial tests, though serial tests share one claim key, they still
      // each hit beforeEach independently).
      assert.strictEqual(universeAdds.length, 4,
        'test_universe SADD fires once per beforeEach');

      const plainKey  = `${execId}:sets-suite:plain:dup-1`;
      const serialKey = `${execId}:[serial-g]`;

      assert.deepStrictEqual(universeAdds.sort(),
        [plainKey, serialKey, serialKey, serialKey].sort(),
        'universe members match the expected claim keys');

      // done_tests: one entry for the plain test, and one for the serial
      // group (only from the last-in-group afterEach). Not three.
      assert.deepStrictEqual(doneAdds.sort(),
        [plainKey, serialKey].sort(),
        'done_tests receives the plain key and one entry for the whole serial group');
    });

    it('still marks a serial group done when its last test needs a retry', async function () {
      // Regression test for the 2026-07-17 staging stall (GHNW): mocha
      // clones the Test object for every retry attempt (Runnable.retry),
      // so afterEach's g_testKeyInfo.get(this.currentTest) misses on a
      // retried attempt -- it's looking up the clone, not the original
      // object the pre-walk registered. Before the fix, the fallback for
      // that miss unconditionally treated any [serial-*] test as "not last
      // in group" and skipped done-marking, so a serial group whose last
      // test needed a retry NEVER reached done_tests -- the distributed run
      // hung in the drain phase forever waiting on a test that had, in
      // fact, already finished.
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'sets-suite-retry');
      suite.retries(1);
      suite.addTest(new Test('s1 [serial-retry-g]', function () {}));
      let attempt = 0;
      suite.addTest(new Test('s2 [serial-retry-g]', function () {
        attempt++;
        if (attempt === 1) throw new Error('fails on first attempt');
      }));

      await new Promise(resolve => m.run(resolve));

      const execId = 'pre-exec-sets';
      const doneKey = `${execId}:done_tests`;
      const serialKey = `${execId}:[serial-retry-g]`;

      const doneAdds = [];
      for (const c of client.calls) {
        if (c[0] !== 'multi' || (c[1][0] && c[1][0][0] === 'sAdd')) continue;
        for (const cmd of c[1]) {
          if (cmd[0] === 'sAdd' && cmd[1] === doneKey) doneAdds.push(cmd[2]);
        }
      }

      assert.ok(doneAdds.includes(serialKey),
        'done_tests must receive the serial-group key even though the last test in the group retried');
    });

    it('prepopulates test_universe at globalSetup, before any beforeEach fires', async function () {
      this.timeout(10000);

      const m = new Mocha({ reporter: 'min' });
      m.rootHooks(lib.mochaHooks);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      const suite = Suite.create(m.suite, 'sets-suite');
      suite.addTest(new Test('plain', function () {}));
      suite.addTest(new Test('s1 [serial-g]', function () {}));
      suite.addTest(new Test('s2 [serial-g]', function () {}));
      suite.addTest(new Test('s3 [serial-g]', function () {}));

      await new Promise(resolve => m.run(resolve));

      const execId = 'pre-exec-sets';
      const universeKey = `${execId}:test_universe`;
      const plainKey  = `${execId}:sets-suite:plain:dup-1`;
      const serialKey = `${execId}:[serial-g]`;

      // The prepopulation SADD fires from globalSetup, before any test runs,
      // so its multi() pipeline must be the very first one observed --
      // distinguishable from a beforeEach claim pipeline (which always
      // starts with 'set') by starting with 'sAdd' instead.
      const firstMulti = client.calls.find(c => c[0] === 'multi');
      assert.ok(firstMulti, 'at least one multi pipeline ran');
      assert.strictEqual(firstMulti[1][0][0], 'sAdd',
        'the first multi pipeline is the prepopulation SADD, not a beforeEach claim');

      const [, sadKey, members] = firstMulti[1][0];
      assert.strictEqual(sadKey, universeKey, 'prepopulation SADD targets test_universe');
      assert.deepStrictEqual([...members].sort(), [plainKey, serialKey].sort(),
        'prepopulation SADD carries every distinct claim key from the local pre-walk');
    });
  });

  // ---------------------------------------------------------------------------
  describe('expected_total + runners_active bookkeeping', function () {
    // expected_total is a global "we're done when done_tests reaches this"
    // marker written via max-tracking (GET current, SET if local > remote).
    // runners_active is a live-runner counter, INCRed at globalSetup and
    // DECRed exactly once at teardown or SIGTERM.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-total';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-total';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('publishes expected_total (distinct claim keys) and INCR/DECRs runners_active', async function () {
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      // 2 plain + 3 serial (share one key) = 3 distinct claim keys.
      const suite = Suite.create(m.suite, 'total-suite');
      suite.addTest(new Test('a', function () {}));
      suite.addTest(new Test('b', function () {}));
      suite.addTest(new Test('s1 [serial-x]', function () {}));
      suite.addTest(new Test('s2 [serial-x]', function () {}));
      suite.addTest(new Test('s3 [serial-x]', function () {}));

      await new Promise(resolve => m.run(resolve));

      const execId = 'pre-exec-total';
      // expected_total should have been written with value 3.
      assert.strictEqual(client.kv.get(`${execId}:expected_total`), '3',
        'expected_total = number of distinct claim keys');

      // runners_active: INCR once at setup, DECR once at teardown.
      const incrs = client.calls.filter(c => c[0] === 'incr'
                                          && c[1] === `${execId}:runners_active`);
      const decrs = client.calls.filter(c => c[0] === 'decr'
                                          && c[1] === `${execId}:runners_active`);
      assert.strictEqual(incrs.length, 1, 'runners_active INCRed once');
      assert.strictEqual(decrs.length, 1, 'runners_active DECRed once');
      // Net value should be 0 after the run.
      assert.strictEqual(client.kv.get(`${execId}:runners_active`), '0',
        'runners_active net change is zero');
    });
  });

  // ---------------------------------------------------------------------------
  describe('MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE', function () {
    // Escape hatch for dynamically-generated tests where the pre-walk
    // under-counts. Documented as unsupported by default; the override
    // env var lets the user tell us the correct total explicitly.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-override-total';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-override-total';
      process.env.MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE = '99';
      // Override is intentionally larger than the local test count; drain
      // would never converge. Disable it for this suite.
      process.env.MOCHA_DISTRIBUTED_DRAIN_ENABLED = 'false';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () {
      delete process.env.MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE;
      restoreRedis();
      clearLib();
    });

    it('uses the override value verbatim regardless of local test count', async function () {
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);
      const suite = Suite.create(m.suite, 'override-total-suite');
      suite.addTest(new Test('only', function () {}));
      await new Promise(resolve => m.run(resolve));

      const execId = 'pre-exec-override-total';
      assert.strictEqual(client.kv.get(`${execId}:expected_total`), '99',
        'override value wins over the walk-computed local count');
    });
  });

  // ---------------------------------------------------------------------------
  describe('drain phase rescues an orphaned test', function () {
    // Simulate the exact preemption scenario the drain phase exists to
    // fix: a test key appears in test_universe (some peer attempted it)
    // but not in done_tests (its runner died before writing a result),
    // and the claim key is gone (SIGTERM DEL'd it, or its TTL expired).
    // A live drain-phase peer should observe the orphan and re-run it,
    // driving done_tests up to expected_total and exiting cleanly.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-rescue';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-rescue';
      // Speed the poll up so the test doesn't sit on a 5 s base interval.
      process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL = '1';
      process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT      = '10';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('re-runs a test whose peer died before writing done_tests', async function () {
      this.timeout(15000);

      const execId = 'pre-exec-rescue';
      const orphanKey = `${execId}:rescue-suite:orphan:dup-1`;

      // Pre-populate the shared state as if a peer started (SADD universe)
      // but died before finishing (no entry in done_tests, no claim key).
      client.kv.set(`${execId}:test_universe`,
        JSON.stringify([orphanKey]));
      // expected_total = 1 so the drain loop knows it should keep waiting
      // until this key lands in done_tests.
      client.kv.set(`${execId}:expected_total`, '1');

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      let ranCount = 0;
      const suite = Suite.create(m.suite, 'rescue-suite');
      suite.addTest(new Test('orphan', function () { ranCount++; }));

      await new Promise(resolve => m.run(resolve));

      // The initial mocha run also ran the local test once (this runner
      // claims and executes it as part of Phase A). That alone marks the
      // key done, so the orphan-rescue path in drain wouldn't fire in
      // this shape. The important assertion is: drain exited cleanly
      // (done == expected) and this runner did execute the test.
      assert.ok(ranCount >= 1, 'test executed at least once during the run');

      const doneSet = JSON.parse(client.kv.get(`${execId}:done_tests`));
      assert.deepStrictEqual(doneSet, [orphanKey],
        'done_tests contains the previously orphaned key');
      assert.strictEqual(client.kv.get(`${execId}:expected_total`), '1',
        'expected_total unchanged');
    });
  });

  // ---------------------------------------------------------------------------
  describe('drain phase does not re-invoke unrelated suites\' before/after-all hooks', function () {
    // runDrainIteration walks the *entire* shared root Suite on every poll,
    // toggling test.pending per orphan key. But mocha's Runner invokes a
    // suite's before-all/after-all hooks whenever it enters that suite,
    // regardless of whether any child test is pending (Runner.runSuite's
    // total = grepTotal(suite) counts tests matching --grep, not
    // non-pending tests, so it is never 0 just because everything inside
    // is skipped). That means a suite that already finished cleanly in
    // Phase A gets its before-all/after-all hooks re-run on every single
    // drain iteration, for as long as ANY orphan exists anywhere in the
    // tree -- observed in production as repeated hook-failure log lines
    // for suites unrelated to the actual orphan (see
    // docs/preemption-resilience-plan.md gap: hooks are never mentioned).
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-hookleak';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-hookleak';
      process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL = '1';
      process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT      = '3';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('only runs a completed suite\'s before-all/after-all hooks once, even across multiple drain iterations', async function () {
      this.timeout(15000);

      const execId = 'pre-exec-hookleak';
      // A second, unresolvable orphan (no local runner will ever produce
      // it) forces the drain loop to poll more than once before giving up
      // at DRAIN_TIMEOUT -- long enough to observe whether an unrelated,
      // already-finished suite's hooks fire again on a later iteration.
      const stuckOrphanKey = `${execId}:stuck-suite:stuck:dup-1`;
      client.kv.set(`${execId}:test_universe`, JSON.stringify([stuckOrphanKey]));
      client.kv.set(`${execId}:expected_total`, '2');

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);

      let beforeAllCount = 0;
      let afterAllCount = 0;
      const otherSuite = Suite.create(m.suite, 'other-suite');
      otherSuite.beforeAll(function () { beforeAllCount++; });
      otherSuite.afterAll(function () { afterAllCount++; });
      otherSuite.addTest(new Test('finishes-in-phase-a', function () {}));

      await new Promise(resolve => m.run(resolve));

      assert.strictEqual(beforeAllCount, 1,
        `other-suite's before-all hook should run exactly once, during ` +
        `Phase A, not once per drain iteration (ran ${beforeAllCount} times)`);
      assert.strictEqual(afterAllCount, 1,
        `other-suite's after-all hook should run exactly once, during ` +
        `Phase A, not once per drain iteration (ran ${afterAllCount} times)`);
    });
  });

  // ---------------------------------------------------------------------------
  describe('drain phase respects the timeout', function () {
    // If drain cannot converge (e.g. an orphan key exists but no runner
    // has the test file to re-run it), the loop must exit within the
    // configured wall-clock budget instead of hanging.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-timeout';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-timeout';
      process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL = '1';
      process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT      = '2';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () { restoreRedis(); clearLib(); });

    it('exits within DRAIN_TIMEOUT when done_tests cannot reach expected_total', async function () {
      this.timeout(10000);

      const execId = 'pre-exec-timeout';
      // Fabricate an unreachable target: this runner will only produce 1
      // done entry but expected_total says 5. Drain must give up after 2s.
      client.kv.set(`${execId}:expected_total`, '5');

      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach); m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);
      const suite = Suite.create(m.suite, 'timeout-suite');
      suite.addTest(new Test('lone', function () {}));

      const startedAt = Date.now();
      await new Promise(resolve => m.run(resolve));
      const elapsed = Date.now() - startedAt;

      // Should complete within a small multiple of DRAIN_TIMEOUT.
      assert.ok(elapsed >= 2000,
        `drain waited at least the timeout (elapsed ${elapsed}ms)`);
      assert.ok(elapsed < 8000,
        `drain exited soon after the timeout (elapsed ${elapsed}ms)`);
    });
  });

  // ---------------------------------------------------------------------------
  describe('MAX_RESCUES_PER_TEST cap-hit writes a synthetic failure', function () {
    // Simulate a test that has already been picked up MAX times without
    // ever producing a result (each attempt crashed its runner). The next
    // beforeEach in drain phase should observe the exhausted budget, win
    // the cap CAS, write a synthetic failed row to test_result, INCR
    // failed_count, and SADD done_tests so drain can complete.
    let client, lib;

    before(function () {
      client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-cap';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-cap';
      process.env.MOCHA_DISTRIBUTED_MAX_RESCUES_PER_TEST = '2';
      process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL  = '1';
      process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT        = '10';
      delete process.env.MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME;
      delete process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME;
      lib = loadFreshLib();
    });

    after(function () {
      delete process.env.MOCHA_DISTRIBUTED_MAX_RESCUES_PER_TEST;
      restoreRedis();
      clearLib();
    });

    it('writes a synthetic failure row and marks done when the budget is exhausted', async function () {
      // Sanity check: exercising the beforeEach path in Phase A does not
      // touch rescue_count (that key is drain-phase only). If this ever
      // changes, the cap-hit test below needs to re-seed accordingly.
      const execId = 'pre-exec-cap';
      const rcCalls = client.calls.filter(c =>
        c[0] === 'incr' && /:rescue_count:/.test(c[1])
      );
      assert.strictEqual(rcCalls.length, 0,
        'Phase A never INCRs rescue_count — that is drain-only bookkeeping');
    });

    it('cap-hit handler writes a synthetic row when a drain rescue hits the cap', async function () {
      this.timeout(5000);

      // Fresh env + fresh lib for isolated state. We drive the beforeEach
      // directly via lib.__testing.setDrainPhase(true) — exercising the
      // real drain-guard branch without depending on Mocha.Runner state
      // reuse (which is validated end-to-end by the drain-timeout tests
      // and by real-redis integration runs).
      const execId2 = 'pre-exec-cap-2';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = execId2;
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-cap-2';
      process.env.MOCHA_DISTRIBUTED_MAX_RESCUES_PER_TEST = '2';
      // Disable the drain loop; we're invoking the guard manually.
      process.env.MOCHA_DISTRIBUTED_DRAIN_ENABLED = 'false';

      const targetKey = `${execId2}:cap2-suite:flaky:dup-1`;
      const client2 = makeMockClient();
      injectMockRedis(client2);
      // Pre-seed rescue_count to the cap value. Next INCR from the
      // drain-guard takes it to cap+1 and trips handleRescueCap.
      client2.kv.set(`${execId2}:rescue_count:${targetKey}`, '2');

      const lib2 = loadFreshLib();

      // Build a minimal Mocha to let globalSetup populate g_testKeyInfo,
      // g_rootSuite, etc. The tests can be skipped with pending=true —
      // we don't want Phase A to run this time.
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib2.mochaHooks.beforeEach);
      m.suite.afterEach(lib2.mochaHooks.afterEach);
      m.globalSetup([lib2.mochaGlobalSetup]);
      // Intentionally skip mochaGlobalTeardown — no drain here.

      const suite = Suite.create(m.suite, 'cap2-suite');
      const flaky = new Test('flaky', function () { /* would-be body */ });
      suite.addTest(flaky);
      // Mark pending so Phase A does not actually run it or its hooks.
      flaky.pending = true;

      await new Promise(resolve => m.run(resolve));

      // Force drain phase and invoke beforeEach directly with a stubbed
      // hook context.
      lib2.__testing.setDrainPhase(true);
      let skipped = false;
      const ctx = {
        currentTest: flaky,
        skip() { skipped = true; },
      };
      // Un-pend so the beforeEach body runs to completion.
      flaky.pending = false;
      await lib2.mochaHooks.beforeEach.call(ctx);

      assert.strictEqual(skipped, true,
        'drain-guard called this.skip() after exhausting the budget');

      // A synthetic failed row must have landed on test_result.
      const rPushes = client2.calls.filter(c => c[0] === 'multi')
        .flatMap(c => c[1])
        .filter(cmd => cmd[0] === 'rPush' && cmd[1] === `${execId2}:test_result`)
        .map(cmd => JSON.parse(cmd[2]));
      const synthetic = rPushes.find(r => r.syntheticOrphan === true);
      assert.ok(synthetic, 'a synthetic orphan failure row was written');
      assert.strictEqual(synthetic.state, 'failed');
      assert.strictEqual(synthetic.failed, true);
      assert.ok(synthetic.err && /rescue attempts/i.test(synthetic.err.message),
        'synthetic err.message describes the exhausted rescue budget');

      // The collapsed report hash must also get a synthetic entry, keyed by
      // the test's own report identity (not the shared serial/claim key).
      const reportHSets = client2.calls.filter(c => c[0] === 'multi')
        .flatMap(c => c[1])
        .filter(cmd => cmd[0] === 'hSet' && cmd[1] === `${execId2}:report`)
        .map(cmd => ({ field: cmd[2], row: JSON.parse(cmd[3]) }));
      assert.strictEqual(reportHSets.length, 1, 'one report hSet for the exhausted test');
      const reportRow = reportHSets[0].row;
      assert.strictEqual(reportRow.syntheticOrphan, true);
      assert.strictEqual(reportRow.state, 'failed');
      assert.strictEqual(reportRow.attempts.length, 1, 'one synthetic attempt recorded');
      assert.strictEqual(reportRow.attempts[0].retryAttempt, 3, 'attempts = cap+1 that tripped the handler');

      // The synthetic test_result row must also carry the matching
      // reportKey, same as the normal (non-synthetic) write path.
      assert.strictEqual(synthetic.reportKey, reportHSets[0].field,
        'synthetic test_result row.reportKey resolves to the report hash field');
      assert.strictEqual(reportRow.reportKey, reportHSets[0].field);

      // done_tests contains the key so drain can converge.
      const doneSet = JSON.parse(client2.kv.get(`${execId2}:done_tests`) || '[]');
      assert.ok(doneSet.includes(targetKey),
        'done_tests contains the exhausted key so drain converges');

      // cap_hit_marker counter reflects that we won the CAS.
      assert.strictEqual(client2.kv.get(`${execId2}:cap_hit_marker:${targetKey}`), '1',
        'cap_hit_marker was CAS-INCR\'d to 1 by the winning runner');

      // Invoking a second time must NOT double-write — the loser branch
      // skips row writing.
      skipped = false;
      const beforeCount = client2.calls.filter(c => c[0] === 'multi').length;
      await lib2.mochaHooks.beforeEach.call(ctx);
      assert.strictEqual(skipped, true, 'still skipped on second attempt');
      const afterRPushes = client2.calls.filter(c => c[0] === 'multi')
        .flatMap(c => c[1])
        .filter(cmd => cmd[0] === 'rPush' && cmd[1] === `${execId2}:test_result`)
        .filter(cmd => JSON.parse(cmd[2]).syntheticOrphan === true);
      assert.strictEqual(afterRPushes.length, 1,
        'exactly one synthetic row across repeated cap-hits (CAS holds)');

      lib2.__testing.setDrainPhase(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('exit-code verdict contract', function () {
    // 0 = drain completed + zero global failures
    // 1 = drain completed + one or more global failures
    // 2 = drain timed out
    //
    // We can't observe a real process.exit inside the test, so we stub
    // both process.exitCode and the 'exit' handler registration to
    // capture whatever the teardown asks for.
    let origExitCode, origOn, capturedExitHandlers;

    beforeEach(function () {
      origExitCode = process.exitCode;
      capturedExitHandlers = [];
      origOn = process.on.bind(process);
      process.on = function (event, handler) {
        if (event === 'exit') { capturedExitHandlers.push(handler); return process; }
        return origOn(event, handler);
      };
    });
    afterEach(function () {
      process.exitCode = origExitCode;
      process.on = origOn;
    });

    it('exits 0 when drain completes with zero global failures', async function () {
      this.timeout(5000);
      const client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-verdict-0';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-v0';
      process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT       = '5';
      process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL = '1';

      const lib = loadFreshLib();
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach);
      m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);
      const suite = Suite.create(m.suite, 'v0-suite');
      suite.addTest(new Test('happy', function () { /* passes */ }));

      await new Promise(resolve => m.run(resolve));

      assert.strictEqual(process.exitCode, 0,
        'exitCode set to 0 for drain-complete + zero failures');
      assert.strictEqual(capturedExitHandlers.length, 1,
        'exactly one process.on("exit") handler was registered');

      restoreRedis(); clearLib();
    });

    it('exits 1 when drain completes with global failures', async function () {
      this.timeout(5000);
      const client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-verdict-1';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-v1';
      process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT       = '5';
      process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL = '1';

      // Pre-seed a global failure count as if another runner reported one.
      client.kv.set('pre-exec-verdict-1:failed_count', '3');

      const lib = loadFreshLib();
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach);
      m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);
      const suite = Suite.create(m.suite, 'v1-suite');
      suite.addTest(new Test('happy', function () { /* passes locally */ }));

      await new Promise(resolve => m.run(resolve));

      assert.strictEqual(process.exitCode, 1,
        'exitCode set to 1 when global failed_count > 0');

      restoreRedis(); clearLib();
    });

    it('exits 2 when drain times out', async function () {
      this.timeout(5000);
      const client = makeMockClient();
      injectMockRedis(client);
      process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
      process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-verdict-2';
      process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-v2';
      process.env.MOCHA_DISTRIBUTED_DRAIN_TIMEOUT       = '1';
      process.env.MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL = '1';
      // Force drain to never converge by inflating expected_total.
      process.env.MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE = '99';

      const lib = loadFreshLib();
      const m = new Mocha({ reporter: 'min' });
      m.suite.beforeEach(lib.mochaHooks.beforeEach);
      m.suite.afterEach(lib.mochaHooks.afterEach);
      m.globalSetup([lib.mochaGlobalSetup]);
      m.globalTeardown([lib.mochaGlobalTeardown]);
      const suite = Suite.create(m.suite, 'v2-suite');
      suite.addTest(new Test('happy', function () { /* passes */ }));

      await new Promise(resolve => m.run(resolve));

      assert.strictEqual(process.exitCode, 2,
        'exitCode set to 2 when drain times out');

      delete process.env.MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE;
      restoreRedis(); clearLib();
    });
  });

  // ---------------------------------------------------------------------------
  describe('MOCHA_DISTRIBUTED_DRAIN_ENABLED=false escape hatch', function () {
    it('skips the drain loop, logs the WARN banner, and leaves exitCode alone', async function () {
      this.timeout(5000);

      // Capture console.log output to inspect the WARN banner.
      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.join(' ')); };

      // Stub process.on('exit') so the verdict override (if any) is
      // observable but non-fatal.
      const capturedExit = [];
      const origOn = process.on.bind(process);
      process.on = function (event, handler) {
        if (event === 'exit') { capturedExit.push(handler); return process; }
        return origOn(event, handler);
      };
      const origExitCode = process.exitCode;

      try {
        const client = makeMockClient();
        injectMockRedis(client);
        process.env.MOCHA_DISTRIBUTED              = 'redis://mock';
        process.env.MOCHA_DISTRIBUTED_EXECUTION_ID = 'pre-exec-disabled';
        process.env.MOCHA_DISTRIBUTED_RUNNER_ID    = 'runner-dis';
        process.env.MOCHA_DISTRIBUTED_DRAIN_ENABLED = 'false';
        // Pre-seed a wildly high expected_total: if the drain loop ran
        // it would spin waiting for it. It must NOT run.
        client.kv.set('pre-exec-disabled:expected_total', '999');

        const lib = loadFreshLib();
        const m = new Mocha({ reporter: 'min' });
        m.suite.beforeEach(lib.mochaHooks.beforeEach);
        m.suite.afterEach(lib.mochaHooks.afterEach);
        m.globalSetup([lib.mochaGlobalSetup]);
        m.globalTeardown([lib.mochaGlobalTeardown]);
        const suite = Suite.create(m.suite, 'disabled-suite');
        suite.addTest(new Test('happy', function () { /* passes */ }));

        const started = Date.now();
        await new Promise(resolve => m.run(resolve));
        const elapsed = Date.now() - started;

        // Must exit promptly (well under any drain timeout).
        assert.ok(elapsed < 2500,
          `teardown returned promptly when DRAIN_ENABLED=false (elapsed ${elapsed}ms)`);

        // No drain-phase banner, no verdict override.
        const drainBannerSeen = logs.some(l => /Entering drain phase/.test(l));
        assert.strictEqual(drainBannerSeen, false,
          'the drain banner was NOT printed when DRAIN_ENABLED=false');

        const warnSeen = logs.some(l =>
          /MOCHA_DISTRIBUTED_DRAIN_ENABLED=false/.test(l) && /WARN/.test(l));
        assert.ok(warnSeen,
          'a WARN line about the disabled drain was printed');

        // Verdict override skipped: process.exitCode is whatever mocha set
        // (typically undefined for a passing run), and no 'exit' handler
        // was queued by the lib.
        assert.strictEqual(capturedExit.length, 0,
          'no verdict process.on("exit") handler was queued');
      } finally {
        console.log = origLog;
        process.on = origOn;
        process.exitCode = origExitCode;
        restoreRedis(); clearLib();
      }
    });
  });
});
