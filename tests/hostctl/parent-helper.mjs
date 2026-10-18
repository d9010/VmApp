// Helper for run.mjs (parent-death test): plays the loader. Spawns vmapp-hostctl with stdin taken from a
// FIFO that the test also holds open (so stdin never reaches EOF), prints the helper's pid, then idles
// until the test kills it with SIGKILL. The helper must then exit because its PARENT died (kqueue
// NOTE_EXIT), not because stdin closed.
//   usage: node parent-helper.mjs <path-to-vmapp-hostctl> <fifo-path>
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

const [bin, fifo] = process.argv.slice(2);
const fd = openSync(fifo, 'r+');
const child = spawn(bin, [], { stdio: [fd, 'ignore', 'ignore'] });
process.stdout.write(`${child.pid}\n`);
setInterval(() => {}, 1000);
