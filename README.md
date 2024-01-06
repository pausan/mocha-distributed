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
    "err": 0
  }
  ```

The JSON formatting will differ since it is saved in a single line.

Keep in mind that:

* Duration and start/end times are in milliseconds.
* Some fields are duplicated in a way, like "state" and "failed" by design
  because sometimes is handy to have this when reading results back.
* You can access test_result, passed_count and failed_count in redis
* Skipped tests are never saved in redis by design, unfortunately

You might have a look at list-tests-from-redis.js for an example on how to
query redis and list all tests.

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

Also the exit code of the different mocha runners will differ. The
ones whose tests fail, will return an error, and the ones whose tests work well
or have been skipped will return 0.

## Build systems

### jenkins, bamboo, circle-ci, gitlab, travis...

If you use jenkins, bamboo or any other build system, make sure
one redis is installed somewhere and all runners can access to it.

Create as many processes, nodes, dockers, kubernetes pods as you wish,
but for each of the runners that you create, make sure each of them can connect 
to the redis instance (e.g are in the same network).

You can use the project name and build ID or job id as the execution ID for
mocha-distributed. Use something unique among the builds of all your projects.

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