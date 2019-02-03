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
const querystring = require('querystring');
const crypto = require('crypto');

const constants = require('./constants.js');

let g_masterAddress = null;

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
// askMasterIfShouldRun
//
// Asks master server if the current runner should run given suite.
//
// Right now we only ask for suites because it seems the safest approach
// -----------------------------------------------------------------------------
async function askMasterIfShouldRun (testPath) {
  const testSuite = querystring.escape(testPath[0]);
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

// -----------------------------------------------------------------------------
// sendTestResultToMaster
// -----------------------------------------------------------------------------
async function sendTestResultToMaster (testPath, status) {
  const path = querystring.escape(testPath.join(constants.TEST_PATH_SEPARATOR));
  const r = await axios.get (`http://${g_masterAddress}/runner/${g_runnerId}/result?test=${path}&status=${status}`);
}

// -----------------------------------------------------------------------------
// init
//
// Initialize this module
// -----------------------------------------------------------------------------
function init (masterAddress){
  g_masterAddress = masterAddress;
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
    if (!await askMasterIfShouldRun (testPath))
      return;

    try {
      const testResult = await fn();
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_SUCCESS);
      return testResult;
    }
    catch (e) {
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_FAILED);
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
function execHookMochaMethod (title, orgMochaMethod, testPath) {
  g_testPath.push (title);
  const testPath = g_testPath.slice(0);
  g_testPath.pop();

  return orgMochaMethod (async function () {
    if (!await askMasterIfShouldRun (testPath))
      return;

    try {
      const testResult = await fn();
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_SUCCESS);
      return testResult;
    }
    catch (e) {
      await sendTestResultToMaster (testPath, constants.TEST_STATUS_FAILED);
      throw e;
    }
  });
}

// -----------------------------------------------------------------------------
// before
// -----------------------------------------------------------------------------
async function before (fn) {
  return execHookMochaMethod (':before', g_mochaMethods.before, testPath);
}

// -----------------------------------------------------------------------------
// beforeEach
// -----------------------------------------------------------------------------
async function beforeEach (fn) {
  return execHookMochaMethod (':beforeEach', g_mochaMethods.beforeEach, testPath);
}

// -----------------------------------------------------------------------------
// after
// -----------------------------------------------------------------------------
async function after (fn) {
  return execHookMochaMethod (':after', g_mochaMethods.after, testPath);
}

// -----------------------------------------------------------------------------
// afterEach
// -----------------------------------------------------------------------------
async function afterEach (fn) {
  return execHookMochaMethod (':afterEach', g_mochaMethods.after, testPath);
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
