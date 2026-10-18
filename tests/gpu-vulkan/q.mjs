// q.mjs SOCKET "COMMAND": sends one request line to the test core (tests/core-echo) through the launcher's bridge socket and
// prints its first reply line. Unlike `printf ... | nc -U`, it keeps the connection open until the reply has arrived: the
// experimental libkrun backend (SPEC 8.7) maps the host's end-of-file on a vsock socket to a reset of the whole connection, so a
// client that half-closes right after writing (nc does) never sees the answer. A real bridge client never half-closes.
// Exit 0 with the line on stdout; exit 1 (nothing printed) on a timeout or an error.
import net from 'node:net';

const [sock, ...rest] = process.argv.slice(2);
const cmd = rest.join(' ');
const limitMs = Number(process.env.Q_TIMEOUT_MS || 8000);
if (!sock || !cmd) {
  process.stderr.write('usage: q.mjs SOCKET COMMAND\n');
  process.exit(2);
}
const c = net.createConnection(sock);
let buf = '';
const timer = setTimeout(() => process.exit(1), limitMs);
c.on('connect', () => c.write(cmd + '\n'));
c.on('data', (d) => {
  buf += d.toString('utf8');
  const i = buf.indexOf('\n');
  if (i >= 0) {
    clearTimeout(timer);
    process.stdout.write(buf.slice(0, i + 1));
    c.destroy();
    process.exit(0);
  }
});
c.on('error', () => process.exit(1));
c.on('close', () => {
  clearTimeout(timer);
  if (buf) process.stdout.write(buf.endsWith('\n') ? buf : buf + '\n');
  process.exit(buf ? 0 : 1);
});
