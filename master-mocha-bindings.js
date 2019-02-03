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
const constants = require('./constants.js');

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
let g_testResults = new Map();
let g_testEventEmitter = null;

// -----------------------------------------------------------------------------
// setEventEmitter
//
// To communicate with the mocha bindings
// -----------------------------------------------------------------------------
function setEventEmitter (testEventEmitter) {
  g_testEventEmitter = testEventEmitter;
}

// -----------------------------------------------------------------------------
// describe
//
// Custom version to describe a test, with same signature
// -----------------------------------------------------------------------------
async function describe (title, fn) {
  g_testPath.push (title);

  // TODO: handle timeouts!!
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
  const testId   = testPath.join(constants.TEST_PATH_SEPARATOR);
  const listenerId = constants.EVENT_FINISHED + ':' + testId;
  g_testPath.pop();

  // TODO: manage timeouts

  // Two listeners are created, once beforehand, and other in runtime.
  //
  // Runtime one will wait the master to receive the status... but since the
  // master node runs serially, it can also happen that another runner executes
  // the tests before the master can initialize the second event listener, and
  // we use this one to capture the result beforehand.
  g_testEventEmitter.once (
    listenerId,
    function (test) {
      g_testResults.set (test.id, test);
    }
  );

  // define our own function hook to wait until the test finishes
  return g_mochaMethods.it (title, async function () {
    await new Promise(function (resolve, reject) {
      // helper function to avoid repeating the code twice
      function helperProcessTestResult(test) {
        if (test.status === constants.TEST_STATUS_FAILED) {
          reject (test.error);
          return;
        }

        resolve();
      }

      if (g_testResults.has(testId)) {
        const test = g_testResults.get (testId);
        helperProcessTestResult (test);
        return;
      }

      // first event-listener has not triggered, so let's install another
      // event listener to resolve as quickly as possible
      g_testEventEmitter.once (listenerId, helperProcessTestResult);
    });
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
    // TODO: wait
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
  setEventEmitter,
  describe,
  it,
  before,
  beforeEach,
  after,
  afterEach
};
