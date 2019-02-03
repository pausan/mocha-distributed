const util = require('./util.js');

// require('mocha-distributed')
require('../index.js');

describe('suite-2', async function() {
  describe('suite-2.1', async function() {
    it('test-2.1.1', async function() {
      await util.sleep(0.25);
    });

    it('test-2.1.2', async function() {
      await util.sleep(0.25);
    });

    it('test-2.1.3', async function() {
      await util.sleep(0.25);
    });

    it('test-2.1.4', async function() {
      await util.sleep(0.25);
    });
  });
});
