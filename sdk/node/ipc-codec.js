'use strict';
/**
 * ipc-codec.js: the structured clone algorithm over the bridge's JSON lines (SPEC 6 "Values").
 *
 * Electron's `ipcRenderer.send/invoke`, `ipcMain.handle` results and `webContents.send` carry any value the structured clone algorithm accepts
 * (V8's ValueSerializer): `undefined`, `NaN`, `-0`, `BigInt`, `Date`, `RegExp`, `Map`, `Set`, `Error`, `ArrayBuffer`, typed arrays, boxed
 * primitives, shared references and cycles. The bridge between the launcher and the app's core is JSON lines, which carries none of those. This
 * module is the one place that maps between the two:
 *
 *   encode(value) -> a JSON-safe value. Plain JSON data (strings, finite numbers, booleans, null, arrays, plain objects) is left exactly as it
 *                    is, so a core that knows nothing of this (a Rust or .NET core) is unaffected. Anything else becomes {"$vmapp": "<kind>", …}.
 *   decode(json)  -> the value again: `decode(JSON.parse(JSON.stringify(encode(v))))` is what `structuredClone(v)` returns.
 *
 * Used by the launcher (hostlib/bridge.js) and by the guest SDK (sdk/node/vmapp.js), both of which run Node. Unit tests compare it with Node's own
 * `structuredClone` (the same algorithm Electron uses) in tests/unit/ipc-codec.test.js.
 *
 * Differences from the browser's algorithm, all deliberate:
 *   - a Node `Buffer` is sent as a `Uint8Array` of exactly its bytes (a Buffer is a view into a shared 8 KiB pool, which structured clone would
 *     copy whole); every other view carries its whole ArrayBuffer, and views of one buffer in one message still share it
 *   - holes in arrays become `undefined`; properties of an array that are not indexes are dropped
 *   - a value that cannot be cloned throws Error("<what> could not be cloned."), the text V8 uses; it is a plain Error as in Electron
 *   - `decode` rejects what `encode` cannot have produced (an unknown kind, a bad reference, nesting deeper than MAX_DEPTH) with a TypeError
 */
const { types } = require('util');

const TAG = '$vmapp';
const MAX_DEPTH = 1000;
const ERROR_TYPES = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const VIEW_TYPES = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

function cloneError(what) {
  return new Error(`${what} could not be cloned.`);
}

/** V8's description of an object it cannot clone: `#<Promise>`. */
function describe(v) {
  let name = 'Object';
  try {
    const c = v.constructor;
    if (c && typeof c.name === 'string' && c.name) name = c.name;
  } catch {
    /* a getter that throws */
  }
  return `#<${name}>`;
}

function define(obj, key, value) {
  // `obj[key] = value` would set the prototype for "__proto__"
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

function tag(kind, fields) {
  return Object.assign({ [TAG]: kind }, fields);
}

/** `value` as something JSON.stringify keeps whole. Throws Error("… could not be cloned.") for a function, a symbol, a promise, … */
function encode(value) {
  const seen = new Map(); // object -> its number in the order encode reaches them (decode counts the same way)
  let next = 0;

  function enc(v, depth) {
    switch (typeof v) {
      case 'string':
      case 'boolean':
        return v;
      case 'number':
        if (Object.is(v, -0)) return tag('num', { v: '-0' });
        return Number.isFinite(v) ? v : tag('num', { v: String(v) });
      case 'undefined':
        return tag('undef');
      case 'bigint':
        return tag('bigint', { v: v.toString() });
      case 'symbol':
        throw cloneError(String(v));
      case 'function':
        throw cloneError(Function.prototype.toString.call(v));
      default:
    }
    if (v === null) return null;
    if (seen.has(v)) return tag('ref', { i: seen.get(v) });
    if (depth > MAX_DEPTH) throw new RangeError('Maximum call stack size exceeded');
    seen.set(v, next++);
    const d = depth + 1;

    if (Array.isArray(v)) {
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i++) out[i] = enc(v[i], d);
      return out;
    }
    if (types.isDate(v)) {
      const ms = v.getTime();
      return tag('date', { v: Number.isNaN(ms) ? null : ms });
    }
    if (types.isRegExp(v)) return tag('regexp', { s: v.source, f: v.flags });
    if (types.isArrayBuffer(v)) return tag('ab', { b: Buffer.from(v).toString('base64') });
    if (ArrayBuffer.isView(v)) {
      if (Buffer.isBuffer(v)) {
        // not the pool it lives in (see the header). The buffer written here is a new object of the message, which decode numbers: so must we.
        next++;
        return tag('view', { t: 'Uint8Array', b: tag('ab', { b: v.toString('base64') }), o: 0, l: v.length });
      }
      const t = Object.prototype.toString.call(v).slice(8, -1);
      if (!Object.hasOwn(VIEW_TYPES, t)) throw cloneError(describe(v));
      const isData = t === 'DataView';
      return tag('view', { t, b: enc(v.buffer, d), o: v.byteOffset, l: isData ? v.byteLength : v.length });
    }
    if (types.isMap(v)) {
      const entries = [];
      for (const [k, x] of v) entries.push([enc(k, d), enc(x, d)]);
      return tag('map', { e: entries });
    }
    if (types.isSet(v)) {
      const items = [];
      for (const x of v) items.push(enc(x, d));
      return tag('set', { e: items });
    }
    if (types.isNativeError(v)) {
      let name = 'Error';
      try {
        const n = v.name;
        if (typeof n === 'string' && Object.hasOwn(ERROR_TYPES, n)) name = n;
      } catch {
        /* keep Error */
      }
      const out = { n: name };
      if (Object.hasOwn(v, 'message')) out.m = String(v.message);
      if (typeof v.stack === 'string') out.s = v.stack;
      if (Object.hasOwn(v, 'cause')) out.c = enc(v.cause, d);
      return tag('error', out);
    }
    if (types.isBoxedPrimitive(v)) {
      if (types.isSymbolObject(v)) throw cloneError(describe(v));
      if (types.isBigIntObject(v)) return tag('box', { t: 'bigint', v: v.valueOf().toString() });
      if (types.isNumberObject(v)) return tag('box', { t: 'number', v: enc(v.valueOf(), d) });
      return tag('box', { t: types.isStringObject(v) ? 'string' : 'boolean', v: v.valueOf() });
    }
    if (types.isProxy(v) || types.isPromise(v) || types.isWeakMap(v) || types.isWeakSet(v) || types.isSharedArrayBuffer(v) || types.isExternal(v)) {
      throw cloneError(describe(v));
    }
    if (types.isGeneratorObject(v) || types.isModuleNamespaceObject(v) || types.isMapIterator(v) || types.isSetIterator(v) || types.isArgumentsObject(v)) {
      throw cloneError(describe(v));
    }

    // an ordinary object (a class instance too): its own enumerable string keys; the prototype is dropped
    const out = {};
    for (const k of Object.keys(v)) define(out, k, enc(v[k], d));
    return Object.hasOwn(out, TAG) ? tag('obj', { v: out }) : out;
  }

  return enc(value, 0);
}

function bad(why) {
  return new TypeError(`ipc value: ${why}`);
}

/** The value that `encode` was given, from what came back through JSON.parse. */
function decode(json) {
  const table = []; // the objects made so far, in the order encode numbered them

  function ownKeys(x) {
    return Object.keys(x);
  }

  function dec(x, depth) {
    if (x === null || typeof x !== 'object') return x; // string, number, boolean (undefined cannot come out of JSON)
    if (depth > MAX_DEPTH) throw bad('nested too deeply');
    const d = depth + 1;

    if (Array.isArray(x)) {
      const out = [];
      table.push(out);
      for (let i = 0; i < x.length; i++) out.push(dec(x[i], d));
      return out;
    }
    if (!Object.hasOwn(x, TAG)) {
      const out = {};
      table.push(out);
      for (const k of ownKeys(x)) define(out, k, dec(x[k], d));
      return out;
    }

    const kind = x[TAG];
    switch (kind) {
      case 'undef':
        return undefined;
      case 'num': {
        const m = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 };
        if (typeof x.v !== 'string' || !Object.hasOwn(m, x.v)) throw bad('bad number');
        return m[x.v];
      }
      case 'bigint':
        if (typeof x.v !== 'string' || !/^-?\d+$/.test(x.v)) throw bad('bad bigint');
        return BigInt(x.v);
      case 'ref': {
        if (!Number.isInteger(x.i) || x.i < 0 || x.i >= table.length) throw bad('bad reference');
        return table[x.i];
      }
      case 'obj': {
        if (x.v === null || typeof x.v !== 'object' || Array.isArray(x.v)) throw bad('bad object');
        const out = {};
        table.push(out);
        for (const k of ownKeys(x.v)) define(out, k, dec(x.v[k], d));
        return out;
      }
      case 'date': {
        const out = new Date(x.v === null ? NaN : x.v);
        if (x.v !== null && typeof x.v !== 'number') throw bad('bad date');
        table.push(out);
        return out;
      }
      case 'regexp': {
        if (typeof x.s !== 'string' || typeof x.f !== 'string') throw bad('bad regexp');
        let out;
        try {
          out = new RegExp(x.s, x.f);
        } catch {
          throw bad('bad regexp');
        }
        table.push(out);
        return out;
      }
      case 'ab': {
        if (typeof x.b !== 'string') throw bad('bad array buffer');
        const bytes = Buffer.from(x.b, 'base64');
        const out = new ArrayBuffer(bytes.length);
        new Uint8Array(out).set(bytes);
        table.push(out);
        return out;
      }
      case 'view': {
        const slot = table.length;
        table.push(undefined); // the view is numbered before its buffer
        if (typeof x.t !== 'string' || !Object.hasOwn(VIEW_TYPES, x.t)) throw bad('bad view');
        const buffer = dec(x.b, d);
        if (!(buffer instanceof ArrayBuffer)) throw bad('bad view');
        let out;
        try {
          out = new VIEW_TYPES[x.t](buffer, x.o, x.l);
        } catch {
          throw bad('bad view');
        }
        table[slot] = out;
        return out;
      }
      case 'map': {
        if (!Array.isArray(x.e)) throw bad('bad map');
        const out = new Map();
        table.push(out);
        for (const pair of x.e) {
          if (!Array.isArray(pair) || pair.length !== 2) throw bad('bad map');
          out.set(dec(pair[0], d), dec(pair[1], d));
        }
        return out;
      }
      case 'set': {
        if (!Array.isArray(x.e)) throw bad('bad set');
        const out = new Set();
        table.push(out);
        for (const item of x.e) out.add(dec(item, d));
        return out;
      }
      case 'error': {
        if (typeof x.n !== 'string' || !Object.hasOwn(ERROR_TYPES, x.n)) throw bad('bad error');
        const out = new ERROR_TYPES[x.n]();
        table.push(out);
        if (x.m !== undefined) {
          if (typeof x.m !== 'string') throw bad('bad error');
          define(out, 'message', x.m);
          Object.defineProperty(out, 'message', { enumerable: false });
        }
        if (x.s !== undefined) {
          if (typeof x.s !== 'string') throw bad('bad error');
          Object.defineProperty(out, 'stack', { value: x.s, writable: true, enumerable: false, configurable: true });
        }
        if (x.c !== undefined) Object.defineProperty(out, 'cause', { value: dec(x.c, d), writable: true, enumerable: false, configurable: true });
        return out;
      }
      case 'box': {
        let out;
        if (x.t === 'bigint') {
          if (typeof x.v !== 'string' || !/^-?\d+$/.test(x.v)) throw bad('bad box');
          out = Object(BigInt(x.v));
        } else if (x.t === 'number') {
          out = Object(dec(x.v, d));
          if (typeof out.valueOf() !== 'number') throw bad('bad box');
        } else if (x.t === 'string' || x.t === 'boolean') {
          if (typeof x.v !== x.t) throw bad('bad box');
          out = Object(x.v);
        } else {
          throw bad('bad box');
        }
        table.push(out);
        return out;
      }
      default:
        throw bad(`unknown kind ${JSON.stringify(String(kind)).slice(0, 40)}`);
    }
  }

  return dec(json, 0);
}

module.exports = { encode, decode, TAG, MAX_DEPTH };
