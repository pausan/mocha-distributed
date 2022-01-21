// -----------------------------------------------------------------------------
// Copyright (c) 2018 Pau Sanchez
//
// MIT Licensed
// -----------------------------------------------------------------------------

const redis = require("redis");

async function getTestResults(redisHost = 'localhost', redisPort = 6379) {
  const allResults = []
  try {
    const redisClient = redis.createClient({
      url: `redis://${redisHost}:${redisPort}/`
    });

    await redisClient.connect()

    // get all potential test results keys
    const keyResults = await redisClient.keys('*:test_result')

    // we can get all in parallel
    const parallelResults = []
    for(const key of keyResults) {
      const rawResultList = await redisClient.lRange(key, 0, -1)

      let passed = 0
      let failed = 0
      let aggregatedDurationMs = 0
      let firstStartTime = null
      let lastEndTime = null
      const jsonResultList = []
      for (const rawResult of rawResultList) {
        const jsonResult = JSON.parse(rawResult)
        jsonResultList.push(jsonResult)

        // compute some extra stuff
        if (firstStartTime === null || jsonResult.startTime < firstStartTime) {
          firstStartTime = jsonResult.startTime
        }

        if (lastEndTime === null || jsonResult.endTime > lastEndTime) {
          lastEndTime = jsonResult.endTime
        }

        passed += (jsonResult.state === "passed")
        failed += (jsonResult.state === "failed")

        aggregatedDurationMs += (jsonResult.duration || 0)
      }

      // sort all jsonResultList by the full test route, because they will
      // be visualized better
      jsonResultList.sort((a, b) => (a.id.join('/') > b.id.join('/')) ? 1 : -1)

      allResults.push({
        key: key,
        start_time : firstStartTime || 0,
        end_time : lastEndTime || 0,
        aggregated_duration: aggregatedDurationMs,
        real_duration: (firstStartTime && lastEndTime) ? lastEndTime - firstStartTime : aggregatedDurationMs,
        tests_passed : passed,
        tests_failed : failed,
        test_results : jsonResultList
      })
    }

    // sort results by startTime, most recent first
    allResults.sort((a, b) => (a.start_time < b.start_time) ? 1 : -1)

    await redisClient.quit()
    return allResults
  }
  catch(e) {
    console.error ("Test Error: ", e)
    return false
  }
}


// -----------------------------------------------------------------------------
// Print results as JSON output
// -----------------------------------------------------------------------------
getTestResults().then( (results) => {
  console.log (JSON.stringify(results, null, 2))
})