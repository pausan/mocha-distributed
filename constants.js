// -----------------------------------------------------------------------------
// constants.js
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------

const RUNNER_ID_PREFIX = 'runner-';

const TEST_STATUS_RUNNING = 'running';
const TEST_STATUS_SUCCESS = 'success';
const TEST_STATUS_FAILED  = 'failed';

const TEST_PATH_SEPARATOR = '>>>';

const ERRORS = {
  INVALID_REQUEST : 'INVALID_REQUEST',
  INVALID_TEST_ID : 'INVALID_TEST_ID',
  INVALID_REQUEST_ACTION : 'INVALID_REQUEST_ACTION',
  INVALID_RUNNER_OWNERSHIP : 'INVALID_RUNNER_OWNERSHIP',
  ALREADY_RUNNING : 'ALREADY_RUNNING',
};

module.exports = {
  RUNNER_ID_PREFIX,
  TEST_STATUS_RUNNING,
  TEST_STATUS_SUCCESS,
  TEST_STATUS_FAILED,
  TEST_PATH_SEPARATOR,
  ERRORS
};
