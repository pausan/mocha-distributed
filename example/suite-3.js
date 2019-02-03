const util = require('./util.js');

// require('mocha-distributed')
require('../index.js');

describe ('suite-3', async function () {
  beforeEach (function () {
    console.log ('before each');
  });

  it ('test-3.1', async function () {
    await util.sleep(0.5);
  });

  it ('test-3.2', async function () {
    await util.sleep(0.5);
  });

  it ('test-3.3', async function () {
    await util.sleep(0.5);
  });

  it ('test-3.4', async function () {
    await util.sleep(0.5);
  });
});