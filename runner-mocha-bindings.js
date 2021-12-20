// -----------------------------------------------------------------------------
// runner-mocha-bindings.js
//
// NOTE: mocha first does a first pass executing all describe/it/... and then
//       when it has gathered all information, it runs the functions associated
//       to each. What we do is we hook our method in the middle and call
//       or not, the original test method.
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------
const axios = require('axios');
const redis = require('redis');
const querystring = require('querystring');
const crypto = require('crypto');

const constants = require('./constants.js');

let g_initialized = false;
let g_masterAddress = null;
let g_testExecutionId = ''; // to differentiate different executions (in redis)

// Generate a unique random id for this runner (with almost 100% certainty
// to be different on any machine/environment).
const g_runnerIdBuffer = Buffer.alloc(16);
const g_runnerId = crypto.randomFillSync(g_runnerIdBuffer).toString('hex');

let g_mochaMethods = {
  describe   : global.describe || null,
  it         : global.it || null,
  before     : global.before || null,
  beforeEach : global.beforeEach || null,
  after      : global.after || null,
  afterEach  : global.afterEach || null
};

// contains the actual test path such as suite.title > suite.title > it.title
let g_testPath = [];

// -----------------------------------------------------------------------------
// _redisSet(key, value, expirationTimeInSeconds)
//
// Saves given value to a redis database
//
// NOTE: it might seem that all these connects and sets and quits are a waste,
//       and they kind of are, but it is the simplest way to avoid having to
//       deal with all sort of scenarios
// -----------------------------------------------------------------------------
async function _redisSet(key, value, expirationTimeInSeconds) {
  const rd = redis.createClient({ url: g_masterAddress})
  rd.on('error', (err) => {
    console.log('Redis Client Error', err)
    console.log('Closing application!')
    process.exit(-1)
  })

  await rd.connect();
  const result = await rd.setEx(key, expirationTimeInSeconds, JSON.stringify(value, null, 2))
  await rd.quit();
  return result
}

// -----------------------------------------------------------------------------
// _redisGet(key)
//
// Returns a value from redis database
//
// NOTE: see _redisGet
// -----------------------------------------------------------------------------
async function _redisGet(key) {
  const rd = redis.createClient({ url: g_masterAddress})
  rd.on('error', (err) => {
    console.log('Redis Client Error', err)
    console.log('Closing application!')
    process.exit(-1)
  })

  await rd.connect()
  const value = await rd.get (key)
  await rd.quit()

  return value === null ? null : JSON.parse(value)
}

// -----------------------------------------------------------------------------
// customHttpMasterAskIfTestShouldRun
//
// Asks master server if the current runner should run given suite.
//
// TODO: Right now we only ask for suites because it seems the safest approach.
//
// Returns:
//  - true: the caller should run the test
//  - false: the caller should not run the test
//  - null: connectivity issue with the master, it depends on the caller to
//    decide what to do
// -----------------------------------------------------------------------------
async function customHttpMasterAskIfTestShouldRun (testPath) {
  const testSuite = querystring.escape(testPath[0]);
  try {
    const r = await axios.get (`http://${g_masterAddress}/runner/${g_runnerId}/should-run?test=${testSuite}`);
    const ok = (r.data.answer === 'run');

    // we ask for given test, so we can save the result properly
    // TODO: this can be removed if the server accepts runners
    if (ok) {
      const path = querystring.escape(testPath.join(constants.TEST_PATH_SEPARATOR));
      const r = await axios.get (`http://${g_masterAddress}/runner/${g_runnerId}/should-run?test=${path}`);
    }
    return ok;
  }
  catch (e) {
    // ignore connection errors
    // the master could have died because it already finished
  }

  // skip (should not run) if there is any kind of error with master
  return null;
}

// -----------------------------------------------------------------------------
// customHttpMasterSendTestResult
// -----------------------------------------------------------------------------
async function customHttpMasterSendTestResult (testPath, status, error) {
  // TODO: use POST
  const path = querystring.escape(testPath.join(constants.TEST_PATH_SEPARATOR));
  let serror = querystring.escape(JSON.stringify(error || null));

  try {
    const r = await axios.get (
      `http://${g_masterAddress}/runner/${g_runnerId}/result?test=${path}&status=${status}&error=${serror}`
    );
  }
  catch (e) {
    // ignore connection errors
    // the master could have died because it already finished
  }
}

// -----------------------------------------------------------------------------
// redisAskIfTestShouldRun
//
// TODO: Right now we only ask for suites because it seems the safest approach.
//
// Returns:
//  - true: the caller should run the test
//  - false: the caller should not run the test
//  - null: connectivity issue with the master, it depends on the caller to
//    decide what to do
// -----------------------------------------------------------------------------
async function redisAskIfTestShouldRun(testPath) {
  // TODO: use test path instead of key, but then deal with before/beforeEach/...
  const testSuite = querystring.escape(testPath[0]);

  const testKey = `${g_testExecutionId}_${testSuite}`
  const result = await _redisGet(testKey)

  return (result === null) || (g_runnerId === result.runnerId)
}

// -----------------------------------------------------------------------------
// redisSendTestResult
// -----------------------------------------------------------------------------
async function redisSendTestResult (testPath, status, error) {
  //console.log ("send path:", testPath)
  // TODO: use test path instead of key
  const testSuite = querystring.escape(testPath[0]);

  try {
    const _24h = 24*3600
    const testKey = testSuite
    const testResult = {
      runnerId : g_runnerId,
      test : testPath,
      status : status,
      error : error
    }

    await _redisSet(`${g_testExecutionId}_${testKey}`, testResult, _24h)
  }
  catch (e) {
    console.log ("ERROR:", e)
    // ignore connection errors
    // the master could have died because it already finished
  }
}

// -----------------------------------------------------------------------------
// askIfTestShouldRun
//
// Asks master server if the current runner should run given suite.
//
// Right now we only ask for suites because it seems the safest approach.
//
// Returns:
//  - true: the caller should run the test
//  - false: the caller should not run the test
//  - null: connectivity issue with the master, it depends on the caller to
//    decide what to do
// -----------------------------------------------------------------------------
async function askIfTestShouldRun (testPath) {
  if(isRedisUrl(g_masterAddress)) {
    return redisAskIfTestShouldRun(testPath)
  }

  return customHttpMasterAskIfTestShouldRun(testPath)
}

// -----------------------------------------------------------------------------
// sendTestResultToMaster
// -----------------------------------------------------------------------------
async function sendTestResultToMaster (testPath, status, error = null) {
  if(isRedisUrl(g_masterAddress)) {
    return redisSendTestResult(testPath, status, error)
  }
  return customHttpMasterSendTestResult(testPath, status, error)
}

// -----------------------------------------------------------------------------
// isRedisUrl
// -----------------------------------------------------------------------------
function isRedisUrl(url) {
  return /^rediss?:\/\/.*$/i.test(url)
}

// -----------------------------------------------------------------------------
// init
//
// Initialize this module
//
// IMPORTANT: only the first call to init will initialize the module!
// -----------------------------------------------------------------------------
function init (masterAddress, defaultPort, testExecutionId) {
  if (g_initialized)
    return;

  g_initialized = true
  g_testExecutionId = testExecutionId;

  if (isRedisUrl(masterAddress)) {
    g_masterAddress = masterAddress;
  }
  else if (masterAddress.includes (':')) {
    g_masterAddress = masterAddress;
  }
  else {
    g_masterAddress = `${masterAddress}:${defaultPort}`;
  }
}

// -----------------------------------------------------------------------------
// describe
//
// Custom version to describe a test, with same signature
// -----------------------------------------------------------------------------
async function describe (title, fn) {
  g_testPath.push (title);
  const result = g_mochaMethods.describe (title, fn);
  g_testPath.pop();

  return result;
}

// TODO:
// describe.skip = async function (title, fn) { }
// describe.once = async function (title, fn) { }


// -----------------------------------------------------------------------------
// it
// -----------------------------------------------------------------------------
async function it (title, fn) {
  // store current path for when the 'it' function executes
  g_testPath.push (title);
  const testPath = g_testPath.slice(0);
  g_testPath.pop();

  // define our own function hook
  return g_mochaMethods.it (title, async function () {
    if (!await askIfTestShouldRun (testPath)) {
      this.skip();
      return;
    }

    try {
      const testResult = await fn();
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_SUCCESS);
      return testResult;
    }
    catch (e) {
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_FAILED, e);
      throw e;
    }
  });
}

// -----------------------------------------------------------------------------
// execHookMochaMethod
//
// Method used accross all mocha hooks (before, beforeEach, after, afterEach)
// in order to query the master server if it needs to be executed or not.
// -----------------------------------------------------------------------------
function execHookMochaMethod (title, orgMochaMethod, fn) {
  g_testPath.push (title);
  const testPath = g_testPath.slice(0);
  g_testPath.pop();

  return orgMochaMethod (async function () {
    if (!await askIfTestShouldRun (testPath)) {
      this.skip();
      return;
    }

    try {
      const testResult = await fn();
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_SUCCESS);
      return testResult;
    }
    catch (e) {
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_FAILED, e);
      throw e;
    }
  });
}

// -----------------------------------------------------------------------------
// before
// -----------------------------------------------------------------------------
async function before (fn) {
  return execHookMochaMethod (':before', g_mochaMethods.before, fn);
}

// -----------------------------------------------------------------------------
// beforeEach
// -----------------------------------------------------------------------------
async function beforeEach (fn) {
  return execHookMochaMethod (':beforeEach', g_mochaMethods.beforeEach, fn);
}

// -----------------------------------------------------------------------------
// after
// -----------------------------------------------------------------------------
async function after (fn) {
  return execHookMochaMethod (':after', g_mochaMethods.after, fn);
}

// -----------------------------------------------------------------------------
// afterEach
// -----------------------------------------------------------------------------
async function afterEach (fn) {
  return execHookMochaMethod (':afterEach', g_mochaMethods.after, fn);
}

module.exports = {
  init,
  describe,
  it,
  before,
  beforeEach,
  after,
  afterEach
};
