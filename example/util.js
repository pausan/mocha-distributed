const util = require('./util.js');

async function sleep (seconds) {
  return new Promise (function (resolve, reject) {
    setTimeout (resolve, seconds * 1000);
  });
}

module.exports = {
  sleep
}