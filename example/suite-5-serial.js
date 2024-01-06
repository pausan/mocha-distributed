const util = require('./util.js');

// require('mocha-distributed')
require('../index.js');

describe ('suite-5.serial', async function () {
  beforeEach (function () {
    // console.log ('before each');
  });

  it ('[serial] test-5.0', async function () {
    await util.serialTestConcurrency('serial5')
  });

  it ('[serial:odd-worker] test-5.1', async function () {
    await util.serialTestConcurrency('odd-worker')
  });

  it ('[serial:even-worker] test-5.2', async function () {
    await util.serialTestConcurrency('even-worker')
  });

  it ('[serial:odd-worker] test-5.3', async function () {
    await util.serialTestConcurrency('odd-worker')
  });

  it ('[serial:even-worker] test-5.4', async function () {
    await util.serialTestConcurrency('even-worker')
  });

  it ('[serial] test-5.5', async function () {
    await util.serialTestConcurrency('serial5')
  });
});