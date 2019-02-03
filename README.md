# mocha-distributed

The aim of this project is to provide a simple way of running distributed mocha
tests without having to change too many lines of code.

It does not matter if you run the tests in one machine as subprocesses or in
many machines with multiple processes each.

Hopefully you will only need to include a single line of code on each of your
mocha files in order for them to run in parallel.

Even including this like keeps your test mocha-compatible, so that you could
run them in your local machine as if nothing was changed.

A idea for the future is to create a mocha-compatible runner so that you don't
even have to do that. But let's go one step at a time.

## How it works: Overview

The concept is very simple, this module hooks all mocha calls so that you need
to create several mocha processes (across one or many machines), and set
one of them to be the master, and the rest of them to be the runners.

Runners connect to the master and for each suite they ask whether they are
the 'owners' to run that suite or not, and if they are, they run it. If
they are not, they just skip the test as 'passed'.

All test results are sent to the master, which will have the truth about
what happened on each test.

IMPORTANT: still work in progress

## How it works: In practice

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

Quick examples:

To run mocha in one computer (e.g your dev computer):

    $ mocha test/\*\*/\*.js

To run mocha distributed:

  - Execute as master in only one machine (imagine it is running on 1.2.3.4 IP address):

        $ MOCHA_DISTRIBUTED="master" mocha test/\*\*/\*.js

  - Execute runners on one or a thousand machines/processes as:

        $ MOCHA_DISTRIBUTED="1.2.3.4" mocha test/\*\*/\*.js


## Build systems: jenkins, bamboo, circle-ci, gitlab, travis...

If you use jenkins, bamboo or any other build system, only one runner should
be defined as the master.

The rest of the runners should have visibility to the master and be able to
send pings HTTP requests to it, because the master will create an HTTP server
and the runners will send requests to it.
