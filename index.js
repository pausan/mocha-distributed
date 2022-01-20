const redis = require("redis");
const crypto = require("crypto");

const GRANULARITY = {
  TEST: "test",
  SUITE: "suite",
};

// Initialize variables from environment
const g_redisAddress = process.env.MOCHA_DISTRIBUTED || "";
const g_testExecutionId = process.env.MOCHA_DISTRIBUTED_EXECUTION_ID || "";
const g_expirationTime =
  process.env.MOCHA_DISTRIBUTED_EXPIRATION_TIME || `${24 * 3600}`;

// Generate a unique random id for this runner (with almost 100% certainty
// to be different on any machine/environment).
const _randomRunnerBuf = Buffer.alloc(16);
const _randomRunnerId = crypto.randomFillSync(_randomRunnerBuf).toString("hex");
const g_runnerId = process.env.MOCHA_DISTRIBUTED_RUNNER_ID || _randomRunnerId;
let g_granularity =
  process.env.MOCHA_DISTRIBUTED_GRANULARITY || GRANULARITY.TEST;
const g_mochaVerbose = process.env.MOCHA_DISTRIBUTED_VERBOSE === "true";

if (g_granularity !== GRANULARITY.TEST) {
  g_granularity = GRANULARITY.SUITE;
}

let g_redis = null;

// -----------------------------------------------------------------------------
// getTestPath
//
// Returns an array with the test suites and test name from a test context
// as found in the hooks
//
// Example:
//
//    >>> getTestPath(ctxt)
//
// -----------------------------------------------------------------------------
function getTestPath(testContext) {
  const path = [testContext.title];

  while (!testContext.root && testContext.parent) {
    testContext = testContext.parent;

    if (testContext && !testContext.root) {
      path.push(testContext.title);
    }
  }

  return path.reverse();
}

// -----------------------------------------------------------------------------
// Initialize redis once before the tests
// -----------------------------------------------------------------------------
exports.mochaGlobalSetup = async function () {
  if (g_mochaVerbose) {
    const redisNoCredentials = g_redisAddress.replace(
      /\/\/[^@]*@/,
      "//***:***@"
    );
    console.log("---------------------------------------------------");
    console.log(" Mocha Distributed");
    console.log("   - Runner Id                :", g_runnerId);
    console.log("   - Redis Address            :", redisNoCredentials);
    console.log("   - Execution Id             :", g_testExecutionId);
    console.log("   - Data Expiration Time     :", g_expirationTime);
    console.log("   - Test Parallel Granularity:", g_granularity);
    console.log("---------------------------------------------------");
  }

  if (!g_redisAddress || !g_testExecutionId) {
    console.log (g_redisAddress, g_testExecutionId)
    console.error(
      "You need to set at least the following environment variables:\n" +
        "  - MOCHA_DISTRIBUTED\n" +
        "  - MOCHA_DISTRIBUTED_EXECUTION_ID\n"
    );
    process.exit(-1);
  }

  g_redis = redis.createClient({ url: g_redisAddress });
  g_redis.on("error", (err) => {
    console.log("Redis Client Error", err);
    console.log("Closing application!");
    process.exit(-1);
  });
  await g_redis.connect();
};

// -----------------------------------------------------------------------------
// Quit from redis
// -----------------------------------------------------------------------------
exports.mochaGlobalTeardown = async function () {
  if (g_redis) {
    await g_redis.quit();
  }
};

// -----------------------------------------------------------------------------
// Hook tests
//
// Please note that we run skip before each test if the ownership of it has
// already been defined by another runner.
// -----------------------------------------------------------------------------
exports.mochaHooks = {
  beforeEach: async function () {
    const testPath = getTestPath(this.currentTest);
    const testKeyFullPath = `${g_testExecutionId}:${testPath.join(":")}`;
    const testKeySuite = `${g_testExecutionId}:${testPath[0]}`;

    const testKey =
      g_granularity === GRANULARITY.TEST ? testKeyFullPath : testKeySuite;

    // Atomically set/get the runner id associated to this test. Only the first
    // runner to get there will set the value to its own runner id.
    const [_, assignedRunnerId] = await g_redis
      .multi()
      .set(testKey, g_runnerId, { EX: g_expirationTime, NX: true })
      .get(testKey)
      .exec();

    if (assignedRunnerId !== g_runnerId) {
      this.currentTest.title += " (skipped by mocha_distributted)";
      this.skip();
    }
  },
  afterEach(done) {
    const SKIPPED = "pending";

    // Save all data in redis in a way it can be retrieved and aggregated
    // easily for all test by an external reporter
    if (this.currentTest.state !== SKIPPED) {
      const testResult = {
        id: getTestPath(this.currentTest),
        type: this.currentTest.type,
        title: this.currentTest.title,
        timedOut: this.currentTest.timedOut,
        duration: this.currentTest.duration,
        file: this.currentTest.file,
        state: this.currentTest.state,
        speed: this.currentTest.speed,
        err: this.currentTest.err | null,
      };

      // save results as single line on purpose
      const key = `${g_testExecutionId}:test_result`;
      g_redis.rPush(key, JSON.stringify(testResult));
      g_redis.expire(key, g_expirationTime);

      // increment passed_count/failed_count & set expiry time
      const countKey = `${g_testExecutionId}:${this.currentTest.state}_count`
      g_redis.incr(countKey);
      g_redis.expire(countKey, g_expirationTime);
    }

    done();
  },
};
