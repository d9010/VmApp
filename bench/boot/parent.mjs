// Helper for bench/boot/boot.mjs: a parent process that starts vmapp-vm with piped stdio, like the loader does, so the benchmark can
// kill it with SIGKILL and watch the VM disappear (tests/e2e.sh scenario 6 does the same with an inline script).
//
//   node parent.mjs <path to vmapp-vm> <vmapp-vm arguments...>
//
// Prints "PID <pid of vmapp-vm>" and then relays everything vmapp-vm prints on stdout.
import cp from 'node:child_process';

const [vm, ...args] = process.argv.slice(2);
const child = cp.spawn(vm, args, { stdio: ['pipe', 'pipe', 'pipe'] });
console.log(`PID ${child.pid}`);
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d)); // so that the benchmark can report why a VM did not start
child.on('error', (e) => {
  console.error(`cannot run ${vm}: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code === null ? 1 : code));
setInterval(() => {}, 1000);
