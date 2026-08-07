# mocha-distributed

Run mocha tests in parallel.

Speed up your mocha tests by running them in parallel in multiple machines all
at once without changing a single line of code. You only need a redis server.

## Purpose

The aim of this project is to provide a simple way of running distributed mocha
tests without having to change any line of code, nor having to decide
what to run where. Tests spread automatically according to the nodes you have.

The concept is very simple, basically you spawn as many runners as you wish
on as many nodes as you wish, and each process decides whether they should run
a test or the test has already been executed or is being executed somewhere
else.

It does not matter if you run the tests in one machine in multiple processes or
in multiple machines with multiple processes each. It will just work.

You don't need to change a single line of code, thus, this library it allows you
to continue developing tests as usual and launch them in parallel whenever you
want. No strings attached.

## Quick start

You don't need to change a single line of code on your tests, this project uses
mocha hooks in order to work, so the only thing you'll need to do in preparation
is:

  ```bash
  $ npm install -s mocha-distributed
  ```

Make sure you have a redis running somewhere with IP visibility from the machine
or machines where you want to run the tests on.

Finally, on each of the runners just run:

  ```bash
    $ export MOCHA_DISTRIBUTED_EXECUTION_ID="execution__2024-01-01__20:10"
    $ export MOCHA_DISTRIBUTED="redis://redis.address"
    $ mocha --require mocha-distributed test/**/*.js
  ```

There are several environment variables that allow you to control the behaviour
of distributed tests, but this is the simplest way to launch them.

MOCHA_DISTRIBUTED is the one holding the redis address, this is the only
requirement to make mocha-distributed work.

MOCHA_DISTRIBUTED_EXECUTION_ID is the other variable you want to pay attention
to. Make sure you use a different value for each group of runners every time
you launch a test. This variable is what makes possible to make a runner know
whether a test has already been executed or not by other of their peers.

## Environment Variables

  - **MOCHA_DISTRIBUTED** (required)

    Right now this variable is the one used to specify the node that will hold
    information about tests being run. This project only supports redis right
    now. This variable can take the form:

      redis[s]://[[username][:password]@][host][:port]

    Please make sure it has visibility to the desired redis server.

  - **MOCHA_DISTRIBUTED_EXECUTION_ID** (required)

    Make sure this value is different every time you launch your tests. You can
    use any string here, but it should be different across test executions or
    your tests will just be skipped after the second execution.

    Execution ID is used in order to differentiate different runs of the same
    tests among parallel executions. If you launch 10 instances and you want
    tests to be distributed among them, all need to have the same value for this
    variable, otherwise each of them will run all the tests on its own.

    Reusing this variable in different executions will cause your tests to be
    skipped.

    Use a random uuid or other random value, a kubernetes job_name, your
    build system job id, ...

  - **MOCHA_DISTRIBUTED_GRANULARITY** = test

    - test (default)
      Potentially all tests can be executed by any runner in any order. This
      is the default, but if you have trouble running your tests in parallel
      please use "suite" instead

    - suite (safest)

      Launch all tests from the same suite in the same runner. This prevents
      some parallelization errors if your tests are not prepared for full
      paralelization.

  - **MOCHA_DISTRIBUTED_RUNNER_ID** = random-id

    By default this value is initialized automatically with a different random
    string in each machine, BUT you can override this in case you need it for
    whatever reason, although in theory you probably shouldn't.

  - **MOCHA_DISTRIBUTED_EXPIRATION_TIME** = 604800

    Configures to how long the data is kept in redis before it expires (in
    seconds). 7 days is the default. The amount of data in redis is minimal,
    so you probably don't want to play with it.

    It might be helpful to increase it though, if you want to build some sort of
    reporting on top of it, because you can directly explore test results in
    redis. See Tests results in Redis for more info.

    This value is also used as the **tombstone** TTL for completed tests:
    once a test produces a result, its claim key is promoted to this TTL so
    a replacement runner won't re-run it.

  - **MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME** = 600

    TTL (in seconds) for the in-flight claim key a runner sets when it
    starts a test. Defaults to 10 minutes. The runner refreshes this TTL
    every `claim_ttl / 3` seconds while the test is running, so a slow
    test never lets its claim expire under it.

    On graceful shutdown (SIGTERM / SIGINT) the runner DELs its in-flight
    claim so a replacement pod can pick the test up immediately. On a hard
    kill (no signal delivered) the claim auto-expires after this TTL,
    bounding recovery time.

    ### Claim key lifecycle

    A test key in redis goes through three phases:

    1. **In-flight** — short TTL (`MOCHA_DISTRIBUTED_CLAIM_EXPIRATION_TIME`),
       refreshed by a keepalive while the test runs.
    2. **Released on SIGTERM** — DEL'd, so another runner can re-claim it.
    3. **Completed** — promoted to a tombstone with TTL
       `MOCHA_DISTRIBUTED_EXPIRATION_TIME` (7 d default), matching the
       result-list lifetime.

    This makes the runner safe to use on preemptible / spot infrastructure.

  - **MOCHA_DISTRIBUTED_DRAIN_ENABLED** = true

    Controls the *drain phase* that runs after every runner finishes its
    local test iteration. During drain, each runner:

      1. computes the set of orphaned tests (SDIFF `test_universe`
         minus `done_tests`, then filtered to keys whose in-flight
         claim has expired) and re-runs them. `test_universe` is
         prepopulated with every key from each runner's local pre-walk
         at startup (in addition to the incremental SADD every
         `beforeEach` still performs), so a test whose every attempt
         was preempted before its `beforeEach` ever ran is still
         discoverable as an orphan — not just tests that were
         attempted at least once,
      2. periodically polls until the global `done_tests` count reaches
         `expected_total`, then exits with a canonical verdict.

    The drain phase is what makes preemption resilience truly symmetric:
    a peer runner that dies mid-test is rescued by the survivors
    without any leader election or manifest gymnastics. Every runner
    stays online until the shared bookkeeping is settled.

    Set to `false` (or `0`) only if you know you don't need this — e.g.
    on non-preemptible infrastructure where runners never die mid-run.
    When disabled, the library prints a WARN banner and preserves
    mocha's default exit code.

  - **MOCHA_DISTRIBUTED_DRAIN_TIMEOUT** = 1800

    Maximum wall-clock seconds any runner will spend in the drain
    phase before giving up. Should be at least a few multiples of the
    slowest test's execution time — the drain loop needs enough
    headroom to notice a preempted peer, re-claim its work, and run
    it to completion. Kubernetes Job's `activeDeadlineSeconds` should
    generally be larger than this.

  - **MOCHA_DISTRIBUTED_DRAIN_POLL_INTERVAL** = 5

    Seconds between orphan-detection polls when no orphans are found.
    Successful iterations don't wait — the loop rechecks immediately.
    A small (±20%) jitter is applied per iteration to prevent every
    runner from polling in lock-step.

  - **MOCHA_DISTRIBUTED_MAX_RESCUES_PER_TEST** = 3

    Per-test rescue budget. If a single test is picked up by the drain
    phase this many times without ever producing a result (i.e. every
    attempt crashed its runner), it is declared broken: exactly one
    runner (CAS-guarded) writes a synthetic failed row for it to
    `test_result`, bumps `failed_count`, marks it done, and the drain
    loop can finally converge.

  - **MOCHA_DISTRIBUTED_EXPECTED_TOTAL_OVERRIDE** (unset by default)

    Escape hatch to hard-code the value of `expected_total` in redis,
    bypassing the max-of-local-walks discovery. Only useful when your
    heterogeneous runners load different subsets of the same suite —
    a scenario this library is not designed for. If unset (the
    recommended default), each runner publishes its local walk count
    and the max wins.

  - **Exit code contract** (produced by the drain phase)

    When drain is enabled, every runner exits with a canonical global
    verdict rather than mocha's local failCount:

      - `0` — drain completed and no test failed anywhere
      - `1` — drain completed and at least one test failed (possibly on a peer)
      - `2` — drain timed out before all tests were accounted for

    Because the verdict is derived from shared redis counters, every
    runner independently reaches the same value — kubernetes Job
    success is well-defined even when individual pods rescued tests
    for each other.

  - **MOCHA_DISTRIBUTED_VERBOSE** = false
    - false (default)
      Avoid printing verbose information

    - true
      Prints some extra information about the variables, the server, ...
      that might be useful for debugging issues and/or informational.

## Reading test results from Redis

All runners write the test result in JSON format in a specific redis list.

The list is basically the execution ID from the variable
MOCHA_DISTRIBUTED_EXECUTION_ID concatenated to ':test_result'

For example, if you are using: MOCHA_DISTRIBUTED_EXECUTION_ID="abcdefg"

Then the key you should look at in redis will be "abcdefg:test_result"

You can access this list and explore the result of all tests. Each item
on the list will contain information about the test suite, test id, ...
test name, if it timed out or not, duration of the test, result of the test,
if there were any errors, ... all that info is extracted from mocha itself.

You will see something like this on each of the items of the list:

  ```json
  {
    "id": [
      "suite-1-async",
      "test-1.1-async"
    ],
    "type": "test",
    "title": "test-1.1-async",
    "timedOut": false,
    "startTime": 1642705594300,
    "endTime": 1642705594802,
    "duration": 502,
    "file": "/home/psanchez/github/mocha-distributed/example/suite-1.js",
    "state": "passed",
    "failed": false,
    "speed": "slow",
    "err": 0,
    "reportKey": "suite-1-async:test-1.1-async:dup-1"
  }
  ```

The JSON formatting will differ since it is saved in a single line.

Keep in mind that:

* Duration and start/end times are in milliseconds.
* Some fields are duplicated in a way, like "state" and "failed" by design
  because sometimes is handy to have this when reading results back.
* You can access test_result, passed_count and failed_count in redis
* Skipped tests are never saved in redis by design, unfortunately
* `reportKey` is the field name for this test in the collapsed `{execId}:report`
  hash (see below) — use it directly with `HGET {execId}:report <reportKey>`
  instead of recomputing it: the `:dup-N` suffix depends on suite-walk
  registration order and can't be reliably reconstructed from redis data alone
  when titles are duplicated.

You might have a look at list-tests-from-redis.js for an example on how to
query redis and list all tests.

## Collapsed reports (one entry per test)

In addition to `{execId}:test_result` (one LIST entry per attempt, including
retries), mocha-distributed also maintains `{execId}:report` — a redis
**HASH** with exactly one field per logical test, regardless of how many
times it was retried. It's written by the same `afterEach` step that writes
`test_result` (and by the drain-phase rescue-cap handler for orphaned tests),
so it shares `test_result`'s TTL and, like `test_result`, never gets an entry
for skipped tests.

Each hash field's value looks like this:

  ```json
  {
    "reportKey": "suite-1-async:test-1.1-async:dup-1",
    "id": ["suite-1-async", "test-1.1-async"],
    "type": "test",
    "title": "test-1.1-async",
    "timedOut": false,
    "duration": 502,
    "startTime": 1642705594300,
    "endTime": 1642705594802,
    "retryTotal": 1,
    "file": "/home/psanchez/github/mocha-distributed/example/suite-1.js",
    "state": "passed",
    "failed": false,
    "speed": "slow",
    "err": null,
    "stdout": "",
    "stderr": "",
    "attempts": [
      {
        "retryAttempt": 0,
        "duration": 502,
        "state": "passed",
        "timedOut": false,
        "err": null,
        "stdout": "",
        "stderr": ""
      }
    ]
  }
  ```

The top-level fields (`state`, `failed`, `timedOut`, `duration`, `err`,
`stdout`, `stderr`, `speed`, `endTime`) always reflect the **final** attempt.
`startTime` is the **first** attempt's start, so `endTime - startTime` gives
the total wall-clock span across every retry. `retryTotal` stays at the top
level; the per-attempt `retryAttempt` moves into `attempts[]`, which keeps
one entry per attempt in the order they ran.

Use `HGETALL {execId}:report` to fetch every collapsed test result in one
call, or `HGET {execId}:report <field>` for a single test. `reportKey` is
included in the value itself (not just as the hash field name) so a row
pulled via `HGETALL` is self-describing, and — as noted above — the same
`reportKey` is stamped onto every `test_result` row for that test, so you can
go from one to the other without recomputing anything.

## Run tests serially

If you'd like some of your tests to run serially you can use a magic string with
this framework.

Simply add "[serial]" or "[serial-<ID OF YOUR CHOICE>]" to the title of your
test or test suite and all those tests will execute serially by the same runner.

The important part is that the test title contains "[serial" and ends with "]"

It's easier to explain with a couple of examples:

The following tests, regardless of whether they are on the same file or spreaded
in multiple files, will be executed all by the same runner one after another.

Might run in parallel to other tests that don't contain the "[serial]" word,
but will run sequentially for this group.

```javascript
it('Test id 1 [serial]', function() { /* ... */})
it('Test id 2 [serial]', function() { /* ... */})
it('Test id 3 [serial]', function() { /* ... */})
it('Test id 4 [serial]', function() { /* ... */})
```

See this other example below. Again, regardless of whether the tests are on the
same file or spreaded in multiple files, will be executed by two sets of
runners.

```javascript
it('Test id 1 [serial-worker]', function() { /* ... */})
it('Test id 2 [serial-worker]', function() { /* ... */})
it('Test id 3 [serial-another worker]', function() { /* ... */})
it('Test id 4 [serial-another worker]', function() { /* ... */})
```

Test 1 and 2 will be executed by one runner, whereas test 3 and 4 will be
executed by another. In both cases 1 and 2 will be executed sequentially and 3
and 4 also sequentially, but since they have different serial IDs, those two
subgroups of tests can run in parallel (e.g 1 and 2 in parallel with 3 and 4).

And now last example below:

```javascript
describe('[serial-my test id] test multiple things sequentially', function () {
  it('Test id 1', function() { /* ... */})
  it('Test id 2', function() { /* ... */})
  it('Test id 3', function() { /* ... */})
  it('Test id 4', function() { /* ... */})
})
```

The suite contains "[serial-my test id]", but the tests don't contain any serial
magic id. In this case, ALL those tests will run sequentially because the suite
contains the magic word.

Long story short. Add "[serial-whatever you want]" on the title but make sure
that "whatever you want" is the same for the stuff you want to run sequentially.

## Examples

### Environment-agnostic

Make sure at least the following variables are set:

  ```bash
  MOCHA_DISTRIBUTED="redis://1.2.3.4"
  MOCHA_DISTRIBUTED_EXECUTION_ID="a5ce4d8a-5b06-4ec8-aea2-37d7e4b2ffe1"
  ```

Again, execution ID should be a different random number each time you want to
launch tests in parallel.

Example:

  ```bash
  $ mocha --require mocha-distributed test/**/*.js
  ```

Of course, this assumes you have already installed mocha-distributed.

### Run tests in parallel in the same machine

To keep things simple, do something like this:

  ```bash
  $ MOCHA_DISTRIBUTED_EXECUTION_ID=`uuidgen`
  $ MOCHA_DISTRIBUTED="redis://redis-server"

  $ mocha --require mocha-distributed test/**/*.js > output01.txt &
  $ mocha --require mocha-distributed test/**/*.js > output02.txt &
  ...
  $ mocha --require mocha-distributed test/**/*.js > output0N.txt &
  ```

Run as many processes as you'd like.

### Using kubernetes parallel jobs to launch tests

If you plan to use kubernetes to launch parallel jobs, make sure the backoff
limit is set to 1, so it does not retry the job after it fails, and make sure
you set execution ID to a different value each time (but common across all
parallel executions).

The easiest is to use the job ID (not the pod ID). You can do that by exposing
pod metadata information as environment variables.

See https://kubernetes.io/docs/tasks/inject-data-application/environment-variable-expose-pod-information/

### Conceptual overview

The concept is very simple, this module hooks all mocha calls and does some magic
to allow running tests across machines without you having to decide what runs
where, or splitting tests beforehand, etc...

To distribute tests you only need to create several processess across one
or more machines (this method won't care how you spawn your runners), and either
set one of them as the master or use a redis database, and launch as many runners
as you wish.

Each runners connects to the redis instance and for each suite or test,
depending on the granularity, they ask whether they are the 'owners' to run the
tests on that suite or not. If they are, they run it. If they are not, they just
skip the tests and continue running the next suite/tests.

### Caveats

When running with redis, all tests are executed by independent runners, which
means you need to take a look at the output of all the runners and see which
ones were skipped and which ones were executed for you to see if some of those
executed failed.

Since v0.10.0, when the drain phase is enabled (the default), every runner
exits with the same canonical verdict computed from shared redis counters
(`0` = all pass, `1` = at least one failure, `2` = drain timed out). If you
disable drain via `MOCHA_DISTRIBUTED_DRAIN_ENABLED=false`, the runners fall
back to reporting only their local failCount as an exit code — which
differs across pods and can miss failures that happened on peers.

### How preemption resilience works (drain phase)

Each runner lifecycle has two phases:

  1. **Phase A — local iteration.** Mocha walks the suite, each `beforeEach`
     tries to CAS-claim its test in redis, winners run the test and record
     the result. This is the classical behaviour you get with drain disabled.

  2. **Phase B — drain.** After Phase A returns, every runner stays alive
     and cooperatively hunts for orphaned tests: keys present in
     `test_universe` but missing from `done_tests` whose in-flight claim key
     has expired (its owner was preempted before writing the result). Any
     surviving runner can re-claim and re-run the orphan. `test_universe`
     itself is seeded twice: once upfront at startup from each runner's
     local pre-walk (covering tests that never got a single `beforeEach`
     attempt anywhere), and incrementally on every subsequent `beforeEach`
     attempt (covering tests added dynamically after the pre-walk, an
     otherwise-unsupported pattern this keeps degrading gracefully).

     The loop exits when the global `done_tests` count reaches
     `expected_total` (verdict 0 or 1), or after `DRAIN_TIMEOUT` seconds
     (verdict 2). A per-test rescue budget
     (`MAX_RESCUES_PER_TEST`, default 3) prevents a truly broken test
     from spinning the loop forever — once exhausted, a single runner
     writes a synthetic failed row on its behalf and the loop can converge.

The design is fully symmetric: there is no leader, no coordinator, and no
change to your kubernetes manifest beyond making sure
`activeDeadlineSeconds` is comfortably larger than `DRAIN_TIMEOUT`.

## Build systems

### jenkins, bamboo, circle-ci, gitlab, travis...

If you use jenkins, bamboo or any other build system, make sure
one redis is installed somewhere and all runners can access to it.

Create as many processes, nodes, dockers, kubernetes pods as you wish,
but for each of the runners that you create, make sure each of them can connect
to the redis instance (e.g are in the same network).

You can use the project name and build ID or job id as the execution ID for
mocha-distributed. Use something unique among the builds of all your projects.

## Testing mocha-distributed itself

Run the following commands:

```
$ docker compose up -d
$ ./test-example-nworkers.sh 3
```

Validate that tmp-output-*.log have executed properly. Pay special attention to
serial behaviour on the different files/workers and tests with duplicate keys.

## MIT License

Copyright (c) 2018 Pau Sanchez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.