// -----------------------------------------------------------------------------
// master.js
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------
const http = require('http');
const EventEmitter = require('events');
const masterServer = require ('./master-server.js');
const masterMochaBindings = require ('./master-mocha-bindings.js');

// used to notify master that a test has been executed
class TestEmitter extends EventEmitter {};

let g_server = null;
let g_eventEmitter = null;

// -----------------------------------------------------------------------------
// master
//
// Initializes the master server, redefines variables, etc...
// -----------------------------------------------------------------------------
function master (port) {

  // Checking server because this master function might be called once
  // per every mocha file, and we only want to initialize once.
  if (g_server === null) {
    g_eventEmitter = new TestEmitter();

    masterServer.setEventEmitter(g_eventEmitter);
    masterMochaBindings.setEventEmitter (g_eventEmitter);

    g_server = http.createServer(masterServer.mainServerHandler);
    g_server.listen(port, function() {
      console.log("# Mocha distributed master listening at port:", port, "\n");
    });
  }

  // hook all mocha methods
  global.describe   = masterMochaBindings.describe;
  global.it         = masterMochaBindings.it;
  global.before     = masterMochaBindings.before;
  global.beforeEach = masterMochaBindings.beforeEach;
  global.after      = masterMochaBindings.after;
  global.afterEach  = masterMochaBindings.afterEach;
}

module.exports = master;