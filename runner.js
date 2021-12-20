// -----------------------------------------------------------------------------
// runner.js
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------
const runnerMochaBindings = require ('./runner-mocha-bindings.js');

function runner (masterAddress, defaultPort, testUniqueId) {
  runnerMochaBindings.init (masterAddress, defaultPort, testUniqueId);

  // hook all mocha methods
  global.describe   = runnerMochaBindings.describe;
  global.it         = runnerMochaBindings.it;
  global.before     = runnerMochaBindings.before;
  global.beforeEach = runnerMochaBindings.beforeEach;
  global.after      = runnerMochaBindings.after;
  global.afterEach  = runnerMochaBindings.afterEach;
}

module.exports = runner;