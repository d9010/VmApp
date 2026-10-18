#!/usr/bin/env node
'use strict';
// Local servers for the network tests (tests/e2e.sh scenario 10, tests/net/run.sh): they listen on 127.0.0.1 only and are
// reached through the allowlist proxy with `vmapp-vm --dev-allow-loopback --dev-resolve NAME=127.0.0.1` (SPEC 8.3).
//
//   HTTP  GET /hello    -> 200 "hello from the host server"
//         GET /big      -> 200, 1 MiB of "x"
//         GET /headers  -> 200, JSON of the request line and headers the server received (to see what the proxy forwarded)
//         anything else -> 404 "nope"
//   ECHO  a TCP server that sends every byte back (a CONNECT tunnel test needs no TLS)
//
// Prints one line, {"http":PORT,"echo":PORT}, when both listen. Runs until it is killed (the tests do that), and in any
// case exits by itself after 30 minutes so a crashed test run cannot leave it behind.
const http = require('http');
const net = require('net');

const web = http.createServer((req, res) => {
  if (req.url === '/hello') {
    res.end('hello from the host server');
  } else if (req.url === '/big') {
    res.setHeader('content-length', 1048576);
    res.end(Buffer.alloc(1048576, 'x'));
  } else if (req.url === '/headers') {
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
  } else {
    res.statusCode = 404;
    res.end('nope');
  }
});
const echo = net.createServer((s) => {
  s.on('error', () => {});
  s.pipe(s);
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
Promise.all([listen(web), listen(echo)]).then(([h, e]) => {
  process.stdout.write(JSON.stringify({ http: h, echo: e }) + '\n');
});
setTimeout(() => process.exit(0), 30 * 60 * 1000).unref();
