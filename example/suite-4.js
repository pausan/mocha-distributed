const util = require('./util.js');

// require('mocha-distributed')
require('../index.js');

describe ('suite-4', async function () {
  this.timeout (10*1000);

  it ('test-4.1', async function () {
    await util.sleep(0.5);
  })

  it ('test-4.2', async function () {
    await util.sleep(0.5);
  })
})
