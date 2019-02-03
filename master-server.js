// -----------------------------------------------------------------------------
// master-mocha-bindings.js
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------
const url = require('url');
const querystring = require('querystring');
const constants = require('./constants.js');

let g_testsPerRunner = new Map();

// -----------------------------------------------------------------------------
// handleRunnerShouldRun
//
// REST: /runner/<runner-id>/should-run?test=xxxxx
//
// Asks whether the client should run given test
// -----------------------------------------------------------------------------
function handleRunnerShouldRun (req, res) {
  const queryObj = querystring.parse(req.route.query);
  const splitted = req.route.pathname.split('/');
  const runnerId = splitted[2];
  const action = splitted[3];

  const testId = queryObj.test || null;

  // is this test already assigned to somebody else?
  if (!testId) {
    res.write (
      JSON.stringify ({
        answer : 'skip',
        reason : constants.ERRORS.INVALID_TEST_ID
      })
    )
    return;
  }

  if (g_testsPerRunner.has(testId)) {
    const runner = g_testsPerRunner.get (testId).runner;

    // is it a retry? e.g. same runner...
    if (runnerId === runner) {
      g_testsPerRunner.get (testId).retries ++;
      res.write (JSON.stringify ({ answer : 'run' }));
      return;
    }

    // otherwise, it is already running :)
    res.write (
      JSON.stringify ({
        answer : 'skip',
        reason : constants.ERRORS.ALREADY_RUNNING,
        runner : runner
      })
    );
    return;
  }

  // make this runner the owner of running this test
  g_testsPerRunner.set (testId, {
    runner : runnerId,
    status : constants.TEST_STATUS_RUNNING,
    retries: 0,
    start  : Date.now(),
    end    : false
  });

  res.write (
    JSON.stringify ({
      answer : 'run'
    })
  );
}

// -----------------------------------------------------------------------------
// handleRunnerResult
//
// REST: /runner/<runner-id>/result?test=xxxxx&status=success|error
//
// Informs the result of running given test
// -----------------------------------------------------------------------------
function handleRunnerResult (req, res) {
  const queryObj = querystring.parse(req.route.query);
  const splitted = req.route.pathname.split('/');
  const runnerId = splitted[2];
  const action = splitted[3];

  const testId = queryObj.test || null;
  if (!testId || !g_testsPerRunner.has(testId)) {
    res.write (
      JSON.stringify ({
        error : constants.ERRORS.INVALID_TEST_ID
      })
    )
    return;
  }

  if (g_testsPerRunner.get(testId).runner !== runnerId) {
    res.write (
      JSON.stringify ({
        error : constants.ERRORS.INVALID_RUNNER_OWNERSHIP
      })
    )
    return;
  }

  let status = queryObj.status || constants.TEST_STATUS_FAILED;
  console.log ('status', queryObj)
  if (status !== constants.TEST_STATUS_SUCCESS) {
    status = constants.TEST_STATUS_FAILED;
  }

  g_testsPerRunner.get (testId).status = status;
  res.write ( JSON.stringify ({ 'status' : status }) );
}

// -----------------------------------------------------------------------------
// handleRunners
//
// REST: /runner/<runner-id>/*
//
// Handles all requests from all runners (registration, queries, ...)
// -----------------------------------------------------------------------------
function handleRunners (req, res) {
  const queryObj = querystring.parse(req.route.query);
  const splitted = req.route.pathname.split('/');
  const runnerId = splitted[2];
  const action   = splitted[3];

  // TODO: check that runner is registered
  if (!runnerId || !action) {
    res.end();
    return;
  }

  switch (action) {
    case 'should-run': handleRunnerShouldRun (req, res); break;
    case 'result':     handleRunnerResult(req, res); break;
    default:
      console.error ("Invalid action: " + action + "(" + req.url + ")");
      res.write (
        JSON.stringify ({ error : constants.ERRORS.INVALID_REQUEST_ACTION })
      )
      break;
  }
  res.end();
}

// -----------------------------------------------------------------------------
// mainServerHandler
//
// REST: /*
//
// Handles all requests to this master server
// -----------------------------------------------------------------------------
function mainServerHandler (req, res) {
  res.writeHead(200, {'Content-Type': 'application/javascript'});
  req.route = url.parse(req.url);

  // REST: /runner/<runner-id>/*
  //
  // execute actions from given runner
  if (req.route.pathname.startsWith (`/runner/`)) {
    handleRunners (req, res);
  }
  else {
    res.write(JSON.stringify ({ error : constants.ERRORS.INVALID_REQUEST }));
    res.end();
  }
}


module.exports = {
  mainServerHandler
};