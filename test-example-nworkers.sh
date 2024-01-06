#!/bin/bash
export MOCHA_DISTRIBUTED_EXECUTION_ID="eid_$(date +%s)"
export MOCHA_DISTRIBUTED="redis://127.0.0.1"

npm install > /dev/null 2>&1

N=$1
COMMAND="mocha --require ./index.js example/**/*.js"

# cleanup tmp files
rm tmp-*

echo "Spawning $N commands in parallel with Execution ID: $MOCHA_DISTRIBUTED_EXECUTION_ID"

# Run the command N times in the background, saving stdout/stderr
for ((i = 1; i <= N; i++)); do
    $COMMAND >"tmp-output-$i.log" 2>&1 &
done

wait

echo "All tests finished!"