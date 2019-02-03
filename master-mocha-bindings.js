// -----------------------------------------------------------------------------
// master-mocha-bindings.js
//
// Copyright(c) 2019 Pau Sanchez - MIT License
// -----------------------------------------------------------------------------

let g_mochaMethods = {
  describe   : global.describe || null,
  it         : global.it || null,
  before     : global.before || null,
  beforeEach : global.beforeEach || null,
  after      : global.after || null,
  afterEach  : global.afterEach || null
};

// -----------------------------------------------------------------------------
// describe
//
// Custom version to describe a test, with same signature
// -----------------------------------------------------------------------------
function describe (title, fn) {

}

describe.only = function (title, fn) {
  // TODO:
}

describe.skip = function (title, fn) {
  // TODO:
}


async function it (fn) { }
async function before (fn) { }
async function beforeEach (fn) { }
async function after (fn) { }
async function afterEach (fn) { }


// FIXME!


module.exports = {
  describe
}