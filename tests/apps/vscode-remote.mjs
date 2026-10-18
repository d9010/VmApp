// A minimal client of VS Code's remote protocol, for tests/apps/vscode.mjs: the same handshake and IPC that VS Code's web workbench
// speaks to its server (src/vs/platform/remote/common/remoteAgentConnection.ts, src/vs/base/parts/ipc/common/ipc.net.ts and ipc.ts of
// microsoft/vscode 1.142.0, MIT), written from those files' wire formats. It runs on top of a socket from the app's own page shim
// (apps/vscode/shim/vscode-vmapp-shim.js, createSocketFactory), so a test drives the server through exactly the bridge the window uses.
//
//   PersistentProtocol framing: 13-byte header (type u8, id u32be, ack u32be, length u32be) + data. Types: 1 Regular, 2 Control, 3 Ack,
//   5 Disconnect, 9 KeepAlive. Regular messages are numbered; the receiver acknowledges the highest id it has seen.
//   Handshake (Control, JSON): client {type:'auth', auth:<connection token>, data} -> server {type:'sign', data, signedData} ->
//   client {type:'connectionType', commit, signedData, desiredConnectionType: 1 (management)} -> server {type:'ok'} or {type:'error'}.
//   IPC (Regular): the client's first message is its context; then [100 Promise, id, channel, name] + arg ->
//   [201 success | 202 error | 203 error object, id] + body; [102 EventListen, id, channel, name] + arg -> [204 EventFire, id] + event.
//   Values are VS Code's binary serialization: 0 undefined, 1 string, 2/3 buffer, 4 array, 5 JSON, 6 int, lengths as VQL.
import crypto from 'node:crypto';

const T_REGULAR = 1;
const T_CONTROL = 2;
const T_ACK = 3;
const T_DISCONNECT = 5;

function vql(n) {
  n = n >>> 0;
  if (n === 0) return Buffer.from([0]);
  const out = [];
  while (n !== 0) {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

export function serialize(v) {
  if (v === undefined) return Buffer.from([0]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([Buffer.from([1]), vql(b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from([3]), vql(v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from([4]), vql(v.length), ...v.map(serialize)]);
  if (typeof v === 'number' && (v | 0) === v) return Buffer.concat([Buffer.from([6]), vql(v)]);
  const b = Buffer.from(JSON.stringify(v), 'utf8');
  return Buffer.concat([Buffer.from([5]), vql(b.length), b]);
}

export function deserialize(buf, pos = 0) {
  const readVql = () => {
    let value = 0;
    for (let n = 0; ; n += 7) {
      const next = buf[pos++];
      value |= (next & 0x7f) << n;
      if (!(next & 0x80)) return value;
    }
  };
  const type = buf[pos++];
  switch (type) {
    case 0:
      return [undefined, pos];
    case 1: {
      const len = readVql();
      const s = buf.subarray(pos, pos + len).toString('utf8');
      return [s, pos + len];
    }
    case 2:
    case 3: {
      const len = readVql();
      return [Buffer.from(buf.subarray(pos, pos + len)), pos + len];
    }
    case 4: {
      const len = readVql();
      const arr = [];
      for (let i = 0; i < len; i++) {
        const [v, p] = deserialize(buf, pos);
        arr.push(v);
        pos = p;
      }
      return [arr, pos];
    }
    case 5: {
      const len = readVql();
      const v = JSON.parse(buf.subarray(pos, pos + len).toString('utf8'));
      return [v, pos + len];
    }
    case 6:
      return [readVql(), pos];
    default:
      throw new Error(`unknown IPC data type ${type}`);
  }
}

class Protocol {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.outId = 0;
    this.inId = 0;
    this.controls = [];
    this.controlWaiters = [];
    this.onRegular = () => {};
    this.closed = false;
    this.closeReason = '';
    socket.onData((ab) => this._data(Buffer.from(ab)));
    socket.onClose((e) => {
      this.closed = true;
      this.closeReason = (e && e.reason) || 'closed';
      for (const w of this.controlWaiters.splice(0)) w.reject(new Error(`the connection closed: ${this.closeReason}`));
    });
  }

  _send(type, id, ack, data) {
    const h = Buffer.alloc(13);
    h.writeUInt8(type, 0);
    h.writeUInt32BE(id, 1);
    h.writeUInt32BE(ack, 5);
    h.writeUInt32BE(data.length, 9);
    this.socket.send(Buffer.concat([h, data]));
  }

  sendControl(obj) {
    this._send(T_CONTROL, 0, 0, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  sendRegular(data) {
    this._send(T_REGULAR, ++this.outId, this.inId, data);
  }

  nextControl(timeoutMs = 20000) {
    if (this.controls.length) return Promise.resolve(this.controls.shift());
    if (this.closed) return Promise.reject(new Error(`the connection closed: ${this.closeReason}`));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this.controlWaiters.push(w);
      setTimeout(() => {
        const i = this.controlWaiters.indexOf(w);
        if (i >= 0) {
          this.controlWaiters.splice(i, 1);
          reject(new Error('no control message from the server in time'));
        }
      }, timeoutMs);
    });
  }

  _data(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 13) {
      const len = this.buf.readUInt32BE(9);
      if (this.buf.length < 13 + len) break;
      const type = this.buf.readUInt8(0);
      const id = this.buf.readUInt32BE(1);
      const data = this.buf.subarray(13, 13 + len);
      this.buf = this.buf.subarray(13 + len);
      if (type === T_REGULAR) {
        if (id > this.inId) {
          this.inId = id;
          this._send(T_ACK, 0, this.inId, Buffer.alloc(0));
          this.onRegular(Buffer.from(data));
        }
      } else if (type === T_CONTROL) {
        const obj = JSON.parse(data.toString('utf8'));
        const w = this.controlWaiters.shift();
        if (w) w.resolve(obj);
        else this.controls.push(obj);
      } else if (type === T_DISCONNECT) {
        this.closed = true;
        this.closeReason = 'disconnect';
      }
    }
  }
}

class IpcClient {
  constructor(protocol, ctx) {
    this.p = protocol;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve) => (this._ready = resolve));
    protocol.onRegular = (data) => this._message(data);
    protocol.sendRegular(serialize(ctx));
    // the client's own channel server announces itself, as VS Code's IPCClient does (the server may call back)
    protocol.sendRegular(Buffer.concat([serialize([200]), serialize(undefined)]));
  }

  _message(data) {
    const [header, p] = deserialize(data, 0);
    const [body] = p < data.length ? deserialize(data, p) : [undefined];
    const [type, id] = header;
    if (type === 200) this._ready();
    else if (type === 201 || type === 202 || type === 203) {
      const h = this.pending.get(id);
      if (!h) return;
      this.pending.delete(id);
      if (type === 201) h.resolve(body);
      else h.reject(Object.assign(new Error((body && body.message) || JSON.stringify(body)), { remote: body }));
    } else if (type === 204) {
      const fn = this.listeners.get(id);
      if (fn) fn(body);
    }
  }

  async call(channel, name, arg, timeoutMs = 60000) {
    await this.ready;
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${channel}.${name}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
    });
    this.p.sendRegular(Buffer.concat([serialize([100, id, channel, name]), serialize(arg)]));
    return result;
  }

  async listen(channel, name, arg, fn) {
    await this.ready;
    const id = ++this.nextId;
    this.listeners.set(id, fn);
    this.p.sendRegular(Buffer.concat([serialize([102, id, channel, name]), serialize(arg)]));
    return () => {
      this.listeners.delete(id);
      this.p.sendRegular(Buffer.concat([serialize([103, id]), serialize(undefined)]));
    };
  }
}

/** Opens a socket with the page's factory and does VS Code's handshake. Returns {protocol, socket} after the server's 'ok'. */
export async function handshake({ factory, authority, token, commit, connectionType = 1 }) {
  const reconnectionToken = crypto.randomUUID();
  const socket = factory.create(`ws://${authority}/?reconnectionToken=${reconnectionToken}&reconnection=false&skipWebSocketFrames=false`, 'test');
  await new Promise((resolve, reject) => {
    socket.onOpen(resolve);
    socket.onError(reject);
  });
  const protocol = new Protocol(socket);
  protocol.sendControl({ type: 'auth', auth: token, data: crypto.randomUUID() });
  const sign = await protocol.nextControl();
  if (sign.type !== 'sign') throw new Error(`unexpected handshake message ${JSON.stringify(sign)}`);
  protocol.sendControl({ type: 'connectionType', commit, signedData: String(sign.data), desiredConnectionType: connectionType });
  const answer = await protocol.nextControl();
  if (answer.type !== 'ok') throw new Error(`the server refused the connection: ${JSON.stringify(answer)}`);
  return { protocol, socket, reconnectionToken };
}

/** A management connection: the IPC channels of the server (remoteFilesystem, extensions, remoteterminal, request, ...). */
export async function connectManagement(opts) {
  const { protocol, socket } = await handshake({ ...opts, connectionType: 1 });
  const ipc = new IpcClient(protocol, { remoteAuthority: opts.authority, clientId: `test-${crypto.randomUUID()}` });
  await Promise.race([ipc.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('the server did not initialize IPC')), 20000))]);
  return {
    call: (channel, name, arg, timeoutMs) => ipc.call(channel, name, arg, timeoutMs),
    listen: (channel, name, arg, fn) => ipc.listen(channel, name, arg, fn),
    close: () => socket.close(),
    get closed() {
      return protocol.closed;
    },
  };
}

/** A VS Code URI on the server, as the workbench sends it (the server maps vscode-remote://<authority>/path to file:///path). */
export function remoteUri(authority, p) {
  return { $mid: 1, scheme: 'vscode-remote', authority, path: p };
}

/** A minimal VSIX (a zip with extension/package.json and extension/extension.js, stored without compression). */
export function makeVsix(zlib, manifest, code) {
  const files = [
    ['extension/package.json', Buffer.from(JSON.stringify(manifest, null, 2))],
    ['extension/extension.js', Buffer.from(code)],
    ['extension.vsixmanifest', Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/><DisplayName>${manifest.displayName || manifest.name}</DisplayName></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>\n`)],
  ];
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, n, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += lh.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
