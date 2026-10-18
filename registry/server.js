#!/usr/bin/env node
'use strict';
// vmapp app registry server.
//   node registry/server.js [--port 8790] [--host 127.0.0.1] [--data DIR] [--trust-proxy] [--quiet]
// Storage: an append-only event log plus content-addressed package blobs, in a local directory (default) or an
// S3-compatible bucket (REGISTRY_STORAGE=s3 and the S3_* variables). Credentials come from the environment only.
// Data dir: --data, else $REGISTRY_DATA, else $VMAPP_WORK/registry-data (default vmapp/out/work/registry-data).
// Single process only.
// No HTTPS: put it behind a TLS reverse proxy (and then pass --trust-proxy). See registry/README.md.

const { createRegistry, DEFAULT_DATA } = require('./lib/registry');
const { configFromEnv } = require('./lib/storage');

const USAGE = `usage: node registry/server.js [options]

  --port N          listen port (default 8790; 0 picks a free one)
  --host ADDR       bind address (default 127.0.0.1; use 0.0.0.0 or :: only behind a firewall/proxy)
  --data DIR        data directory (default $REGISTRY_DATA or ${DEFAULT_DATA}); with the local storage it holds the store/
                    folder, with s3 it only holds scratch files (tmp/, outbox/)
  --storage TYPE    local (default) or s3; the s3 settings are environment variables only (see registry/.env.example)
  --public-download-base URL
                    redirect downloads to URL/blobs/sha256/<hh>/<sha256>.vmapp (an object-store address, e.g. an R2 custom
                    domain). Also $PUBLIC_DOWNLOAD_BASE.
  --trust-proxy     take the client address from the last X-Forwarded-For entry (set it only behind a proxy
                    that overwrites that header; used for rate limits and download de-duplication)
  --max-package-mib N   largest accepted package (default 512)
  --publish-per-hour N  publishes per address per hour (default 10)
  --api-per-minute N    API requests per address per minute (default 300)
  --snapshot-every N    write a snapshot after N events (default 500)
  --counter-flush-min N append the download counters to the log every N minutes (default 5)
  --public-url URL  the address users reach the registry at (used in verification emails, and for the canonical links, sitemap
                    and other absolute URLs of the web pages; without it those are left out)
  --mailer FILE     a module exporting send({to, subject, text}) -> Promise; default: write .eml files to DATA/outbox
  --dev-allow-http-verify
                    TESTS ONLY: check publisher domains over plain http on a custom port, to private addresses too
  --quiet           do not log requests

Environment (flags win): REGISTRY_PORT, REGISTRY_HOST, REGISTRY_DATA, REGISTRY_STORAGE, REGISTRY_LOCAL_DIR, REGISTRY_TRUST_PROXY,
REGISTRY_PUBLIC_URL, REGISTRY_MAILER, REGISTRY_MAX_PACKAGE_MIB, REGISTRY_PUBLISH_PER_HOUR, REGISTRY_API_PER_MINUTE, REGISTRY_SNAPSHOT_EVERY,
REGISTRY_COUNTER_FLUSH_MIN, REGISTRY_QUIET, REGISTRY_LEASE_TTL_SEC, REGISTRY_LEASE_RENEW_SEC, PUBLIC_DOWNLOAD_BASE, S3_BUCKET, S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID,
S3_SECRET_ACCESS_KEY, S3_SESSION_TOKEN, S3_PATH_STYLE, S3_CONDITIONAL_PUT.
`;

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

function parse(argv, env) {
  const out = {};
  const envNum = (name, scale = 1) => {
    if (env[name] === undefined || env[name] === '') return undefined;
    const v = Number(env[name]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${name} needs a non-negative number`);
    return Math.floor(v * scale);
  };
  const def = {
    port: envNum('REGISTRY_PORT'),
    host: env.REGISTRY_HOST || undefined,
    dataDir: env.REGISTRY_DATA || undefined,
    publicUrl: env.REGISTRY_PUBLIC_URL || undefined,
    mailerFile: env.REGISTRY_MAILER || undefined,
    maxPackageBytes: envNum('REGISTRY_MAX_PACKAGE_MIB', 1024 * 1024),
    publishPerHour: envNum('REGISTRY_PUBLISH_PER_HOUR'),
    apiPerMinute: envNum('REGISTRY_API_PER_MINUTE'),
    snapshotEvery: envNum('REGISTRY_SNAPSHOT_EVERY'),
    counterFlushMs: envNum('REGISTRY_COUNTER_FLUSH_MIN', 60 * 1000),
    // the single-writer lease of the s3 backend (seconds); the defaults (60 and 15) are right for production
    leaseTtlMs: envNum('REGISTRY_LEASE_TTL_SEC', 1000),
    leaseRenewMs: envNum('REGISTRY_LEASE_RENEW_SEC', 1000),
    trustProxy: truthy(env.REGISTRY_TRUST_PROXY) || undefined,
    quiet: truthy(env.REGISTRY_QUIET) || undefined,
  };
  for (const [k, v] of Object.entries(def)) if (v !== undefined) out[k] = v;
  const envOverride = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    const num = () => {
      const v = Number(need());
      if (!Number.isFinite(v) || v < 0) throw new Error(`${a} needs a non-negative number`);
      return v;
    };
    switch (a) {
      case '--port': out.port = num(); break;
      case '--host': out.host = need(); break;
      case '--data': out.dataDir = need(); break;
      case '--storage': envOverride.REGISTRY_STORAGE = need(); break;
      case '--public-download-base': envOverride.PUBLIC_DOWNLOAD_BASE = need(); break;
      case '--trust-proxy': out.trustProxy = true; break;
      case '--max-package-mib': out.maxPackageBytes = Math.floor(num() * 1024 * 1024); break;
      case '--publish-per-hour': out.publishPerHour = num(); break;
      case '--api-per-minute': out.apiPerMinute = num(); break;
      case '--snapshot-every': out.snapshotEvery = Math.floor(num()); break;
      case '--counter-flush-min': out.counterFlushMs = Math.floor(num() * 60 * 1000); break;
      case '--public-url': out.publicUrl = need(); break;
      case '--mailer': out.mailerFile = need(); break;
      case '--dev-allow-http-verify': out.devAllowHttpVerify = true; break;
      case '--quiet': out.quiet = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return { opts: out, env: Object.assign({}, env, envOverride) };
}

async function main() {
  let opts;
  let storageCfg;
  try {
    const p = parse(process.argv.slice(2), process.env);
    opts = p.opts;
    if (!opts.help) storageCfg = configFromEnv(p.env);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const quiet = opts.quiet;
  delete opts.quiet;
  if (opts.mailerFile) {
    try {
      const m = require(require('path').resolve(opts.mailerFile));
      if (typeof m.send !== 'function') throw new Error('it must export a send() function');
      opts.mailer = m;
    } catch (e) {
      process.stderr.write(`vmapp-registry: cannot load --mailer ${opts.mailerFile}: ${e.message}\n`);
      return 2;
    }
    delete opts.mailerFile;
  }
  if (opts.devAllowHttpVerify) console.warn('WARNING: --dev-allow-http-verify is on: domain checks use plain http and may reach private addresses. Tests only.');
  const reg = createRegistry(Object.assign({
    log: (m) => { if (!quiet) console.log(`${new Date().toISOString()} ${m}`); },
    storage: storageCfg.storage,
    publicDownloadBase: storageCfg.publicDownloadBase,
    // the event log can no longer be written (storage down, or the writer lease was lost): stop, so that a supervisor
    // (docker restart: unless-stopped) starts a fresh process that rebuilds its state from the log
    onFault: (err) => {
      process.stderr.write(`vmapp-registry: ${err.message}\n`);
      setTimeout(() => process.exit(1), 500).unref();
    },
  }, opts));
  let info;
  try {
    info = await reg.start();
  } catch (e) {
    process.stderr.write(`vmapp-registry: ${e.message}\n`);
    return 1;
  }
  console.log(`vmapp-registry listening on ${info.url} (data: ${reg.dataDir}, storage: ${reg.store.describe()})`);
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    reg.close().then(() => process.exit(0), (e) => {
      process.stderr.write(`vmapp-registry: shutdown error: ${e.message}\n`);
      process.exit(1);
    });
    setTimeout(() => process.exit(1), 10000).unref();
    void sig;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  return null;
}

main().then((code) => {
  if (code !== null) process.exit(code);
});
