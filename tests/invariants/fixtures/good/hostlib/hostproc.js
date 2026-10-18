'use strict';
// Fixture host processes: hostctl and user-registered tools, argv arrays, never a shell.
const cp = require('child_process');

function startHostCtl(command) {
  return cp.spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
}

function startTool(file, args, opts) {
  return cp.spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: 'pipe', shell: false, detached: true });
}

module.exports = { startHostCtl, startTool };
