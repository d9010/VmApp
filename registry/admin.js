#!/usr/bin/env node
'use strict';
// Registry administration. Reads the same environment as the server (REGISTRY_STORAGE, REGISTRY_DATA, S3_*), so it works
// on whatever storage the server uses. Credentials are never taken from the command line.

const path = require('path');
const { DEFAULT_DATA } = require('./lib/registry');
const { configFromEnv } = require('./lib/storage');
const admin = require('./lib/admin');

const USAGE = `usage: node registry/admin.js <command> [options]

  status                          what the registry holds: events, snapshots, apps, packages
  snapshot                        write snapshots/<seq>.json for the current state (a new file; safe while the server runs)
  verify [--no-blobs]             re-check everything: every event and snapshot, and re-hash every package an event refers to
                                  (--no-blobs: only check that they exist, with the right size). Exit 1 if anything is wrong.
  check-storage                   probe the bucket once (run it on a new bucket): a second PUT must not replace an object, a
                                  copy must refuse a changed source, a presigned PUT must be bound to its size. Leaves 3 tiny
                                  staging/probe-* objects. Safe while the server runs. Exit 1 if the store misbehaves.
  gc [--confirm] [--min-age-hours N]
                                  lists staging objects and packages that no event refers to (at least N hours old, default
                                  24). Deletes them only with --confirm, and writes an admin.gc event. Events, snapshots and
                                  referenced packages are never deleted. Needs the server stopped.
  export --out FILE.tar           a tar of all events and snapshots, for an offline backup (never overwrites FILE)
  migrate --from-db DIR [--dry-run]
                                  convert an old data directory (db.json + packages/) into events and blobs. DIR is only read.
                                  Needs the server stopped. Safe to run again.
  hide <app id> --reason TEXT     take an app off the registry (a tombstone event; nothing is deleted). Needs the server stopped.
  unhide <app id>                 lift it

options for every command:
  --data DIR        data directory (default $REGISTRY_DATA or ${DEFAULT_DATA})
  --storage TYPE    local (default) or s3 ($REGISTRY_STORAGE); the s3 settings are environment variables (S3_BUCKET, ...)
  --local-dir DIR   the local store's directory (default <data dir>/store, $REGISTRY_LOCAL_DIR)

Exit status: 0 done, 1 failed or found a problem, 2 refused or wrong usage.
`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--data': o.data = need(); break;
      case '--storage': o.storage = need(); break;
      case '--local-dir': o.localDir = need(); break;
      case '--confirm': o.confirm = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--no-blobs': o.noBlobs = true; break;
      case '--min-age-hours': o.minAgeHours = Number(need()); break;
      case '--out': o.out = need(); break;
      case '--from-db': o.fromDb = need(); break;
      case '--reason': o.reason = need(); break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        o._.push(a);
    }
  }
  return o;
}

async function run(argv, env = process.env, print = (s) => console.log(s)) {
  let o;
  try {
    o = parse(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  const cmd = o._[0];
  if (o.help || !cmd) {
    process.stdout.write(USAGE);
    return o.help ? 0 : 2;
  }
  const e2 = Object.assign({}, env);
  if (o.storage) e2.REGISTRY_STORAGE = o.storage;
  if (o.localDir) e2.REGISTRY_LOCAL_DIR = o.localDir;
  let cfg;
  try {
    cfg = configFromEnv(e2);
  } catch (e) {
    process.stderr.write(`admin: ${e.message}\n`);
    return 2;
  }
  const dataDir = path.resolve(o.data || e2.REGISTRY_DATA || DEFAULT_DATA);
  const writes = (cmd === 'migrate' && !o.dryRun) || cmd === 'hide' || cmd === 'unhide' || (cmd === 'gc' && o.confirm);
  const known = ['status', 'snapshot', 'verify', 'check-storage', 'gc', 'export', 'migrate', 'hide', 'unhide'];
  if (!known.includes(cmd)) {
    process.stderr.write(`unknown command ${cmd}\n\n${USAGE}`);
    return 2;
  }
  let session = null;
  try {
    if (cmd === 'migrate' && !o.fromDb) throw new admin.AdminError('migrate needs --from-db DIR', 2);
    if (cmd === 'export' && !o.out) throw new admin.AdminError('export needs --out FILE.tar', 2);
    if ((cmd === 'hide' || cmd === 'unhide') && !o._[1]) throw new admin.AdminError(`${cmd} needs an app id`, 2);
    if (cmd === 'gc' && o.minAgeHours !== undefined && !(o.minAgeHours >= 0)) throw new admin.AdminError('--min-age-hours needs a number', 2);
    session = await admin.openSession({ dataDir, storage: cfg.storage, write: writes, allowMissing: cmd === 'migrate' });
    print(`# ${session.store.describe()}, ${session.loaded.seq} events`);
    switch (cmd) {
      case 'status': return await admin.status(session, print);
      case 'snapshot': return await admin.snapshot(session, print);
      case 'verify': {
        const r = await admin.verify({ store: session.store, checkBlobs: !o.noBlobs });
        for (const w of r.warnings) print(`warning: ${w}`);
        for (const e of r.errors) print(`FAIL: ${e}`);
        const s = r.stats;
        print(`${s.events} events, ${s.snapshots} snapshots, ${s.referencedBlobs} packages referenced (${s.blobsChecked} re-hashed, ${s.blobBytes} bytes), ${s.unreferencedBlobs} unreferenced, ${s.stagingObjects} staging`);
        print(r.ok ? 'OK: the registry is consistent' : `NOT OK: ${r.errors.length} problem(s)`);
        return r.ok ? 0 : 1;
      }
      case 'check-storage': {
        const r = await admin.checkStorage({ store: session.store, out: print });
        return r.ok ? 0 : 1;
      }
      case 'gc': {
        const r = await admin.gc({ session, confirm: !!o.confirm, minAgeHours: o.minAgeHours === undefined ? 24 : o.minAgeHours, out: print });
        return r.refused ? 2 : 0;
      }
      case 'export':
        await admin.exportTar({ store: session.store, outFile: o.out, out: print });
        return 0;
      case 'migrate': {
        const r = await admin.migrate({ fromDir: o.fromDb, store: session.store, events: session.events, dryRun: !!o.dryRun, log: print });
        print(r.dryRun
          ? `dry run: ${r.events} events would be written (${r.alreadyThere} are there already)`
          : `migrated: ${r.appended} event(s) appended (${r.alreadyThere} were already there), ${r.blobsWritten} package(s) written, ${r.blobsPresent} already present`);
        return 0;
      }
      case 'hide':
        await admin.hide(session, o._[1], o.reason, print);
        return 0;
      case 'unhide':
        await admin.unhide(session, o._[1], print);
        return 0;
      default:
        return 2;
    }
  } catch (e) {
    process.stderr.write(`admin: ${e.message}\n`);
    return e.exitCode || 1;
  } finally {
    if (session) await session.close();
  }
}

module.exports = { run, USAGE };

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
