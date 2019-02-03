// -----------------------------------------------------------------------------
// index.js
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------

// Three scenarios for MOCHA_DISTRIBUTED:
//   - master (MOCHA_DISTRIBUTED = 'master[:PORT]')
//     Runs the server as master node, waiting for connections and waiting
//     others to run the tests. For simplicity, this node won't execute
//     any tests, but gather the result of all of them.
//
//   - runner (MOCHA_DISTRIBUTED='<master-address>[:PORT]'  IP/DNS of the master node)
//     IP/DNS of the master node (a.k.a runner), this node will get a unique
//     name from the master, and will ask, before each suite or orphaned test
//     if it needs to run it or not
//
//   - Empty or not defined
//     Runs mocha normally, we don't redefine any variable at all.
//     Everything will run locally, if spawned on many machines or processes
//     tests will run on all of them as if this module did not exist.
const master = require('./master.js');
const runner = require('./runner.js');

// Initialize mode & port from environment variable MOCHA_DISTRIBUTED
const DEFAULT_PORT = 12421;
let mode = (process.env.MOCHA_DISTRIBUTED || '').toLowerCase();
let port = DEFAULT_PORT;

if (mode.indexOf (':') >= 0) {
  const splitted = mode.split(':');
  mode = splitted[0];
  port = parseInt (splitted[1], 10);
}

// let's get the party started
if (!mode) {
  // run as normal mocha
}
else if (mode === 'master') {
  master (port);
}
else {
  const masterAddress = mode;
  runner (masterAddress, port);
}

// remove from cache, so it is always reinitialized
delete require.cache[require.resolve('./index.js')];
