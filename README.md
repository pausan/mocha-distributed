# mocha-distributed

The aim of this project is to provide a simple way of running distributed mocha
tests without having to change too many lines of code, nor having to decide
what to run where.

It does not matter if you run the tests in one machine as subprocesses or in
many machines with multiple processes each.

Hopefully you will only need to include a single line of code on each of your
mocha files in order for them to run in parallel.

Your test files will still be 100% compatible with mocha, so you can run them
without any side-effects locally, using mocha, as if nothing was changed.

A idea for the future is to create a mocha-compatible runner so that you don't
even have to change source files in any way. But let's go one step at a time.

## How it works

### Brief example

First, add the following line in each of your test files you want to distribute.
If you try to run the tests without this line, the tests will run on ALL machines,
including the master node.

  ```javascript
  require('mocha-distributed');
  ```

Then, if you want to run mocha in one computer (e.g your dev computer):

  ```bash
  $ mocha test/**/*.js
  ```

To run mocha distributed:

  - Execute as master in only one machine (imagine it is running on 1.2.3.4 IP address):

    ```bash
    $ MOCHA_DISTRIBUTED="master" mocha test/**/*.js
    ```

  - Execute runners on one or a thousand machines/processes as:

    ```bash
    $ MOCHA_DISTRIBUTED="1.2.3.4" mocha test/**/*.js
    ```



### Conceptual overview

The concept is very simple, this module hooks all mocha calls and does some magic
to allow running tests across machines without you having to decide what runs
where, or splitting tests beforehand, etc...

To distribute tests you only need to create several processess across one
or more machines (system won't care), and set one of them as the master,
and the rest as the runners. Only one master allowed.

Runners connect to the master and for each suite they ask whether they are
the 'owners' to run the tests on that suite or not. If they are, they run it.
If they are not, they just skip the tests and continue running the next suite.

For simplicity this is all granularity you'll get for now. If you need two
suites to run one after another on the same machine, then create a suite
that encloses those.

All test results (with error information) are sent to the master, and the master
will display the output of all tests.

If you like to save test results, etc... run the master with the right mocha
parameters. Using those parameters on the runners won't hurt either.

### How to run in practice

There is a magic environment variable called MOCHA_DISTRIBUTED.

When unset or empty, this module does nothing at all. Mocha runs normally,
as if you would have not installed this module.

When set to the special keyword 'master', the mocha will automatically create
an HTTP server and listen to other processes or machines to connect to it and
ask/inform about running the tests.

For the runners, you would need to set MOCHA_DISTRIBUTED variable with the IP
of the master computer that is running the test. If you are running all the
tests in multiple processes you can set it to 127.0.0.1, otherwise it should
be the IP of that machine in your private network, or the public IP if the
machines are distributed around the world.

You can also append the port to both the master and the runners, but in
that case, the port must match.

## Examples

### Run tests in one machine and one process

Just don't use the MOCHA_DISTRIBUTED variable, or set it to empty string.

  ```bash
  $ mocha test/**/*.js
  ```

### Run tests in one machine, multiple processes

To keep things simple, do something like this:

  ```bash
  $ MOCHA_DISTRIBUTED="master" mocha test/**/*.js
  $ MOCHA_DISTRIBUTED="localhost" mocha test/**/*.js > /dev/null &
  $ MOCHA_DISTRIBUTED="localhost" mocha test/**/*.js > /dev/null &
  ...
  $ MOCHA_DISTRIBUTED="localhost" mocha test/**/*.js > /dev/null &
  ```

Run as many processes as you'd like

### Run tests in several processes across several machines

On one machine do:

  ```bash
  $ MOCHA_DISTRIBUTED="master" mocha test/**/*.js
  ```

You can also run some runners in that machine if you wish (see previous example).

Figure out the IP address of the master. For this example let's say the master
IP address is 1.2.3.4. Now on the rest of machines, just do:

  ```bash
  $ MOCHA_DISTRIBUTED="1.2.3.4" mocha test/**/*.js > /dev/null &
  $ MOCHA_DISTRIBUTED="1.2.3.4" mocha test/**/*.js > /dev/null &
  ...
  $ MOCHA_DISTRIBUTED="1.2.3.4" mocha test/**/*.js > /dev/null &
  ```

Again, spawn as many processes as you'd like.

## Build systems

### jenkins, bamboo, circle-ci, gitlab, travis...

If you use jenkins, bamboo or any other build system, only one runner should
be defined as the master. The master never runs tests, only waits.

You should create more processes or launch more docker or kubernetes instances
or spread test on several nodes... do it as you wish, but for each of the
runners that you create, make sure they have visibility to the master (e.g
make sure you can send a ping from all the runners to the master).

In case you run multiple masters on the same machine, make sure you setup
a different port each time, otherwise runner's from different projects will
inform the wrong master.

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