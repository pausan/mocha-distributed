const util = require('./util.js');
const { expect } = require('chai');

// require('mocha-distributed')
require('../index.js');

describe ('suite-7', async function () {
  this.timeout (10*1000);
  this.retries(3);

  // this test is created to make sure that
  for (let i = 0; i < 10; i++) {
    it ('test-7.1-duplicated-title', async function() {
      const retryCount = this.test.currentRetry();
      const id = `${i}`.padStart(2, '0');
      console.log (`[id=${id}] test-7.1-duplicated-title (retry ${retryCount})`);
      await util.sleep(0.1 + 0.5*Math.random());

      // make this test flacky to make sure that it is retried
      if (retryCount < 2) {
        expect (false).to.be.true;
      }
    })
  }
})
