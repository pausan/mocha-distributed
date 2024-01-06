const util = require('./util.js');

// require('mocha-distributed')
require('../index.js');

// NOTE: since "describe" has [serial] on it, all will be executed with that ID
describe ('[serial] suite-6.serial', async function () {
  beforeEach (function () {
    // console.log ('before each');
  });

  it ('[serial] test-6.0', async function () {
    await util.serialTestConcurrency('serial6')
  });

  it ('[serial:odd-worker] test-6.1', async function () {
    await util.serialTestConcurrency('serial6')
  });

  it ('[serial:even-worker] test-6.2', async function () {
    await util.serialTestConcurrency('serial6')
  });

  it ('[serial:odd-worker] test-6.3', async function () {
    await util.serialTestConcurrency('serial6')
  });

  it ('[serial:even-worker] test-6.4', async function () {
    await util.serialTestConcurrency('serial6')
  });

  it ('[serial] test-6.5', async function () {
    await util.serialTestConcurrency('serial6')
  });
});
