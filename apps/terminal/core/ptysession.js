'use strict';
/**
 * One terminal session: a `ptyd` process (bin/ptyd, see ../ptyd/src/main.rs) that runs a command on a pseudo-terminal, and the
 * frame protocol spoken with it over its stdin and stdout:
 *
 *   frame = type byte, 4-byte big-endian payload length, payload
 *   to ptyd:    'D' bytes for the terminal, 'W' resize (rows u16, cols u16), 'K' signal (one byte)
 *   from ptyd:  'R' started (pid u32), 'D' terminal output, 'M' diagnostic text, 'E' exit code (i32, always last)
 *
 * Events: 'started' (pid), 'data' (Buffer), 'message' (string), 'exit' (code). `pause()` / `resume()` stop and restart the
 * flow of output: ptyd then blocks on its pipe, the terminal fills, and the program waits (backpressure all the way).
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const MAX_INPUT_FRAME = 16 * 1024; // keystrokes and pastes are split into frames of at most this size
const FORCE_KILL_MS = 1500; // after stop(), ptyd gets this long to hang the program up before it is killed

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type.charCodeAt(0);
  head.writeUInt32BE(payload.length, 1);
  return payload.length ? Buffer.concat([head, payload]) : head;
}

/** Incremental parser for ptyd's output frames. `push(chunk)` returns the complete frames as [{type, payload}]. */
class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      out.push({ type: String.fromCharCode(this.buf[0]), payload: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

class PtySession extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.ptyd     absolute path of the ptyd binary
   * @param {string[]} o.command  argv of the program to run on the terminal
   * @param {string} o.cwd
   * @param {object} o.env      the program's environment (ptyd passes its own environment on, so this is the whole thing)
   * @param {number} o.rows
   * @param {number} o.cols
   */
  constructor(o) {
    super();
    this.o = o;
    this.proc = null;
    this.pid = null;
    this.exited = false;
    this.exitCode = null;
    this._killTimer = null;
  }

  start() {
    const { ptyd, command, cwd, env, rows, cols } = this.o;
    this.proc = spawn(ptyd, ['--cwd', cwd, '--rows', String(rows), '--cols', String(cols), '--', ...command], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parser = new FrameParser();
    this.proc.stdout.on('data', (chunk) => {
      for (const f of parser.push(chunk)) this._onFrame(f);
    });
    // ptyd prints to stderr only when it cannot start at all; that text never contains the environment.
    let err = '';
    this.proc.stderr.on('data', (d) => {
      if (err.length < 4096) err += d.toString('utf8');
    });
    this.proc.stdin.on('error', () => {}); // EPIPE once ptyd is gone
    this.proc.on('error', (e) => this._finish(127, `cannot run ptyd: ${e.message}`));
    this.proc.on('close', (code, signal) => {
      if (err.trim()) this.emit('message', err.trim());
      this._finish(typeof code === 'number' ? code : 128 + (signal ? 15 : 0));
    });
  }

  _onFrame({ type, payload }) {
    switch (type) {
      case 'R':
        this.pid = payload.length >= 4 ? payload.readUInt32BE(0) : null;
        this.emit('started', this.pid);
        break;
      case 'D':
        this.emit('data', payload);
        break;
      case 'M':
        this.emit('message', payload.toString('utf8'));
        break;
      case 'E':
        this.exitCode = payload.length >= 4 ? payload.readInt32BE(0) : -1;
        break;
      default:
        break;
    }
  }

  _finish(fallbackCode, message) {
    if (this.exited) return;
    this.exited = true;
    clearTimeout(this._killTimer);
    if (message) this.emit('message', message);
    this.emit('exit', this.exitCode !== null ? this.exitCode : fallbackCode);
  }

  _write(buf) {
    if (this.exited || !this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(buf);
  }

  /** Bytes typed by the user (a Buffer or a string). */
  write(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    for (let i = 0; i < buf.length; i += MAX_INPUT_FRAME) this._write(frame('D', buf.subarray(i, i + MAX_INPUT_FRAME)));
  }

  resize(rows, cols) {
    const p = Buffer.alloc(4);
    p.writeUInt16BE(rows, 0);
    p.writeUInt16BE(cols, 2);
    this._write(frame('W', p));
  }

  signal(sig) {
    this._write(frame('K', Buffer.from([sig])));
  }

  pause() {
    if (this.proc) this.proc.stdout.pause();
  }
  resume() {
    if (this.proc) this.proc.stdout.resume();
  }

  /** Hang the program up: SIGHUP to its process group, then end ptyd's input (ptyd kills it a second later if it stays). */
  stop() {
    if (this.exited || !this.proc) return;
    this.resume(); // a paused pipe would keep ptyd from finishing
    this.signal(1);
    try {
      this.proc.stdin.end();
    } catch {
      /* already closed */
    }
    this._killTimer = setTimeout(() => {
      if (!this.exited && this.proc) this.proc.kill('SIGKILL');
    }, FORCE_KILL_MS);
  }
}

module.exports = { PtySession, FrameParser, frame };
