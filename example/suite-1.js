const util = require('./util.js');
const { expect } = require('chai');

// require('mocha-distributed')
require('../index.js');

describe ('suite-1-async', async function () {
  this.timeout (100*1000);

  it ('test-1.1-async', async function () {
    await util.sleep(0.5);
  })

  it ('test-1.2-sync', function () {
    // do nothing
  });

  it ('test-1.3-fail', async function () {
    await util.sleep(0.25);
    expect (false).to.be.true;
  });
});


describe ('suite-1-sync', function () {
  it ('test-1.1-async', async function () {
    await util.sleep(1.5);
  })

  it ('test-1.2-sync', function () {
    // do nothing
  });
});

describe ('suite-1.2-sync', function () {
  describe ('suite-2.1-sync', function () {
    it ('test-1.2-sync', function () {
      // do nothing
    });
  });
});

describe ('suite-1.3-io', function () {
  it ('console.log', function () {
    console.log ("Writing from console.log\nAnother line")
  });

  it ('console.error', function () {
    console.error ("Writing from console.error\nAnother line")
  });

  it ('process.stdout', function () {
    process.stdout.write("Writing from process.stdout. No newline.")
  });

  it ('process.stderr', function () {
    process.stderr.write("Writing from process.stderr. No newline.")
  });

  it ('process.stdout & process.stderr', function () {
    process.stdout.write("stdout output\nanother line")
    process.stderr.write("stderr output\nanother line\nand yet another one.")
  });

});
