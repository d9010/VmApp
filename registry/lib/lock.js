'use strict';
// The single-process lock for a data directory: DATA/server.pid. Refuses to start while another live process holds it.
// (The s3 backend adds a lease in the bucket, lib/lease.js, which also works across machines.)

const fs = require('fs');
const os = require('os');
const path = require('path');

const heldHere = new Set(); // data directories locked by this very process (a second instance in one process is refused too)
const inContainer = () => fs.existsSync('/.dockerenv');

/**
 * Takes the lock and returns the function that releases it. Throws if a live process holds it.
 * The file holds "<pid> <host name>". In a container the lock file survives on the volume while pids and host names are
 * per container, so a file from another host name is stale, and our own pid (the server is pid 1 in its container) means
 * the file is from the container's previous run.
 */
function acquireLock(dataDir) {
  const file = path.join(dataDir, 'server.pid');
  const key = path.resolve(dataDir);
  if (heldHere.has(key)) throw new Error(`data directory ${dataDir} is in use by process ${process.pid} (the registry is a single-process server)`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${process.pid} ${os.hostname()}\n`, { flag: 'wx', mode: 0o600 });
      heldHere.add(key);
      return () => {
        heldHere.delete(key);
        try {
          if (fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0] === String(process.pid)) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      let host = '';
      try {
        [pid, host = ''] = fs.readFileSync(file, 'utf8').trim().split(/\s+/);
        pid = Number(pid);
      } catch {
        /* unreadable: treat as stale */
      }
      let alive = false;
      const otherContainer = inContainer() && host && host !== os.hostname();
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !otherContainer) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (err) {
          alive = err.code === 'EPERM';
        }
      }
      if (alive) throw new Error(`data directory ${dataDir} is in use by process ${pid} (the registry is a single-process server)`);
      try {
        fs.unlinkSync(file);
      } catch {
        /* raced */
      }
    }
  }
  throw new Error(`could not lock ${dataDir}`);
}

module.exports = { acquireLock };
