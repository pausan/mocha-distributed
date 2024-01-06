const fs = require('fs');
const util = require('./util.js');

async function sleep (seconds) {
  return new Promise (function (resolve, reject) {
    setTimeout (resolve, seconds * 1000);
  });
}

// -----------------------------------------------------------------------------
// Append data to given file name, wait for some time, and then continue
// adding end of data.
//
// This will easily make visible on the file whether two tests have been
// executed concurrently or not, since it will mess up the lines on the file
// -----------------------------------------------------------------------------
async function serialTestConcurrency(name) {
  const fname = `tmp-${name}.tmp`

  fs.appendFileSync(fname, `${name}: [Start: ${Date.now()} -> `)
  await sleep(1);
  fs.appendFileSync(fname, ` End:${Date.now()}]\n`)
}

module.exports = {
  sleep,
  serialTestConcurrency
}