// -----------------------------------------------------------------------------
// master.js
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------
const http = require('http');
const masterServer = require ('./master-server.js');
const masterMochaBidings = require ('./master-mocha-bindings.js');

let g_server = null;

// -----------------------------------------------------------------------------
// master
//
// Initializes the master server, redefines variables, etc...
// -----------------------------------------------------------------------------
function master (port) {
  console.log ("Starting master server on port: " + port);

  // Checking server because this master function might be called once
  // per every mocha file, and we only want to initialize once.
  if (g_server === null) {
    g_server = http.createServer(masterServer.mainServerHandler);

    g_server.listen(port, function() {
      console.log("Server start at port: " + port);
    });
  }

  // FIXME! redefine describe, it, etc...
}

module.exports = master;