'use strict';
// Starts a throw-away MinIO server in Docker for tests/registry/s3.test.js (only when VMAPP_TEST_MINIO=1).
//   - the image is pinned by digest (override with VMAPP_TEST_MINIO_IMAGE; the default is Chainguard's MinIO build,
//     because Docker Hub's minio/minio is no longer published)
//   - its data lives under $VMAPP_WORK/minio-data/<run id>
//   - the random root credentials reach the container through its environment, never a command line
//   - it refuses to start Docker work when the disk holding Docker's data has less than 8 GB free
//   - stop() stops and removes exactly the container this run started

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const IMAGE = process.env.VMAPP_TEST_MINIO_IMAGE || 'cgr.dev/chainguard/minio@sha256:2136d593beacf4461187035eca949fe49abd589d5079735025c711ca58fee0c8';
const MIN_FREE = 8 * 1024 ** 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freeBytes() {
  for (const p of ['/System/Volumes/Data', '/']) {
    try {
      const s = fs.statfsSync(p);
      return s.bavail * s.bsize;
    } catch {
      /* try the next */
    }
  }
  return Infinity;
}

function docker(args, env) {
  return spawnSync('docker', args, { env: env || process.env, encoding: 'utf8' });
}

function ready(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/minio/health/ready', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** @returns {Promise<{endpoint: string, accessKeyId: string, secretAccessKey: string, region: string, name: string, stop: () => void}>} */
async function startMinio(workDir) {
  if (freeBytes() < MIN_FREE) throw new Error(`less than 8 GB free on the disk Docker uses: not starting MinIO (${(freeBytes() / 1024 ** 3).toFixed(1)} GB free)`);
  const run = crypto.randomBytes(4).toString('hex');
  const name = `vmapp-test-minio-${process.pid}-${run}`;
  const dataDir = path.join(workDir, 'minio-data', run);
  fs.mkdirSync(dataDir, { recursive: true });
  const accessKeyId = 'AK' + crypto.randomBytes(8).toString('hex').toUpperCase();
  const secretAccessKey = crypto.randomBytes(20).toString('hex');
  const env = Object.assign({}, process.env, { MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey });
  // -e NAME (no value) copies the variable from this process's environment
  let r = docker(['run', '-d', '--name', name, '-p', '127.0.0.1::9000', '-v', `${dataDir}:/data`, '-e', 'MINIO_ROOT_USER', '-e', 'MINIO_ROOT_PASSWORD', IMAGE, 'server', '/data'], env);
  if (r.status !== 0) throw new Error(`docker run failed: ${(r.stderr || '').trim()}`);
  const stop = () => {
    docker(['stop', '-t', '3', name]);
    docker(['rm', name]);
    // this run's data folder, and nothing else (the path was built above from the work folder and a random id)
    if (dataDir.startsWith(path.join(workDir, 'minio-data') + path.sep)) fs.rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    r = docker(['port', name, '9000/tcp']);
    const m = /:(\d+)\s*$/m.exec(r.stdout || '');
    if (!m) throw new Error(`cannot find the published port: ${r.stdout} ${r.stderr}`);
    const port = Number(m[1]);
    for (let i = 0; i < 60; i++) {
      if (await ready(port)) return { endpoint: `http://127.0.0.1:${port}`, accessKeyId, secretAccessKey, region: 'us-east-1', name, stop };
      await sleep(500);
    }
    const logs = docker(['logs', '--tail', '20', name]);
    throw new Error(`MinIO did not become ready: ${(logs.stdout || '') + (logs.stderr || '')}`);
  } catch (e) {
    stop();
    throw e;
  }
}

module.exports = { startMinio, IMAGE };
