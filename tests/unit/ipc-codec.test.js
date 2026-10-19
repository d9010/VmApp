'use strict';
// sdk/node/ipc-codec.js against Node's own structuredClone: the same V8 algorithm Electron's ipcRenderer.send/invoke and webContents.send use
// (Electron: shell/common/v8_util.cc, V8Serializer). The cases are those of Electron's spec/api-ipc-spec.ts and spec/api-ipc-renderer-spec.ts
// ("can send instances of Date / Buffer", "objects that both reference the same object", "can handle cyclic references", "throws when sending
// objects with DOM class prototypes", the payload sizes) plus what the structured clone algorithm lists as cloneable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, decode, TAG, MAX_DEPTH } = require('../../sdk/node/ipc-codec.js');

/** What the other side of the bridge gets: through JSON lines, as the bridge writes and reads them. */
const wire = (v) => decode(JSON.parse(JSON.stringify(encode(v))));

/** `v` through the codec equals `v` through structuredClone (deepStrictEqual compares prototypes, Maps, Sets, typed arrays and cycles). */
function same(v, label) {
  assert.deepStrictEqual(wire(v), structuredClone(v), label);
}

test('plain JSON data is left exactly as it is on the wire (a core that knows nothing of the codec is unaffected)', () => {
  const v = { a: 1, b: 'two', c: [true, false, null, 3.5, -7], d: { e: {}, f: [] }, g: '' };
  assert.deepStrictEqual(encode(v), v);
  assert.equal(JSON.stringify(encode(v)), JSON.stringify(v));
  assert.deepStrictEqual(encode([1, 'a', null]), [1, 'a', null]);
  assert.equal(encode('text'), 'text');
  assert.equal(encode(42), 42);
  assert.equal(encode(null), null);
  assert.deepStrictEqual(decode(v), v, 'and decoding what a core wrote as plain JSON gives it back');
});

test('primitives that JSON loses: undefined, NaN, Infinity, -0, BigInt', () => {
  for (const v of [undefined, NaN, Infinity, -Infinity, -0, 0, 1n, -123456789012345678901234567890n, 2 ** 53]) {
    const out = wire(v);
    assert.ok(Object.is(out, v), `${String(v)} -> ${String(out)}`);
  }
  assert.ok(Object.is(wire([-0])[0], -0));
  const o = wire({ a: undefined, b: [undefined, NaN] });
  assert.ok('a' in o && o.a === undefined, 'a key whose value is undefined stays');
  assert.equal(o.b.length, 2);
  assert.ok(Number.isNaN(o.b[1]));
});

test('Electron: "can send instances of Date as Dates" (and an invalid Date)', () => {
  const iso = new Date().toISOString();
  const d = wire(new Date(iso));
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), iso);
  assert.ok(Number.isNaN(wire(new Date('nope')).getTime()));
  same({ when: new Date(0), list: [new Date(5)] });
});

test('Electron: "can send instances of Buffer" arrives as a Uint8Array with the same bytes (not a pool slice)', () => {
  const buf = Buffer.from('hello');
  const out = wire(buf);
  assert.ok(out instanceof Uint8Array);
  assert.ok(Buffer.from('hello').equals(out));
  assert.equal(out.buffer.byteLength, 5, 'its own 5-byte buffer, not the 8 KiB pool the Buffer lives in');
  assert.equal(out.byteOffset, 0);
});

test('a Buffer does not shift the numbering of the references after it', () => {
  const shared = { n: 1 };
  const out = wire([Buffer.from('hi'), shared, [shared], new Uint8Array([1]), shared]);
  assert.ok(out[0] instanceof Uint8Array && Buffer.from(out[0]).toString() === 'hi');
  assert.deepStrictEqual(out[1], { n: 1 });
  assert.equal(out[2][0], out[1], 'the reference points at the object, not at whatever was numbered next');
  assert.equal(out[4], out[1]);
  const cyc = { b: Buffer.from('x') };
  cyc.self = cyc;
  const c = wire(cyc);
  assert.equal(c.self, c);
});

test('typed arrays, DataView, ArrayBuffer: type, offset, length and the bytes', () => {
  const ab = new ArrayBuffer(16);
  new Uint8Array(ab).forEach((_, i, a) => (a[i] = i * 7));
  for (const v of [
    new Uint8Array([1, 2, 3]),
    new Int8Array([-1, 5]),
    new Uint8ClampedArray([0, 255]),
    new Int16Array([-300, 300]),
    new Uint16Array([65535]),
    new Int32Array([-1, 2 ** 31 - 1]),
    new Uint32Array([2 ** 32 - 1]),
    new Float32Array([1.5, -0, NaN]),
    new Float64Array([Math.PI, Infinity]),
    new BigInt64Array([-5n, 2n ** 62n]),
    new BigUint64Array([2n ** 64n - 1n]),
    new DataView(ab, 4, 8),
    new Uint16Array(ab, 2, 4),
    ab,
    new ArrayBuffer(0),
    new Uint8Array(0),
  ]) {
    same(v, Object.prototype.toString.call(v));
  }
  const out = wire(new Uint16Array(ab, 2, 4));
  assert.equal(out.byteOffset, 2);
  assert.equal(out.buffer.byteLength, 16, 'a view carries its whole buffer, as structured clone does');
});

test('views of one buffer in one message still share it', () => {
  const ab = new ArrayBuffer(8);
  const a = new Uint8Array(ab, 0, 4);
  const b = new Uint8Array(ab, 4, 4);
  const [x, y, whole] = wire([a, b, ab]);
  assert.equal(x.buffer, y.buffer);
  assert.equal(x.buffer, whole);
  x[0] = 9;
  assert.equal(new Uint8Array(whole)[0], 9);
});

test('Map, Set (keys and values of any kind, nested)', () => {
  same(new Map([['a', 1], [2, new Map([['x', [1, 2]]])], [{ k: 1 }, new Set([1, 'two'])]]));
  same(new Set([1, 2, new Set([3]), undefined, NaN, -0]));
  same({ m: new Map(), s: new Set() });
});

test('RegExp, boxed primitives', () => {
  same(/ab+c/gi);
  same([new Number(5), new String('s'), new Boolean(false), Object(7n)]);
  assert.ok(Object.is(wire(new Number(-0)).valueOf(), -0));
});

test('Error: the standard types, message, stack and cause; other own properties are dropped (as in structured clone)', () => {
  for (const E of [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError]) {
    const e = new E('boom');
    const out = wire(e);
    assert.ok(out instanceof E, E.name);
    assert.equal(out.name, E.name);
    assert.equal(out.message, 'boom');
    assert.equal(out.stack, e.stack);
    assert.deepStrictEqual(structuredClone(e).message, out.message);
  }
  const withCause = new Error('outer', { cause: new TypeError('inner') });
  const out = wire(withCause);
  assert.ok(out.cause instanceof TypeError);
  assert.equal(out.cause.message, 'inner');
  const custom = Object.assign(new Error('x'), { code: 'E_X', extra: 1 });
  assert.equal(wire(custom).code, undefined);
  class MyError extends Error {}
  MyError.prototype.name = 'MyError';
  assert.equal(wire(new MyError('m')).name, 'Error', 'a name that is not a standard one becomes Error, as in V8');
  assert.equal(wire(new Error()).message, '', 'no message stays no message');
});

test('Electron: "can send objects that both reference the same object"', () => {
  const child = { hello: 'world' };
  const foo = { name: 'foo', child };
  const bar = { name: 'bar', child };
  const array = [foo, bar];
  const [arr, f, b, c] = wire([array, foo, bar, child]);
  assert.deepStrictEqual(arr, array);
  assert.equal(arr[0].child, arr[1].child, 'one child, not two copies');
  assert.equal(f, arr[0]);
  assert.equal(b, arr[1]);
  assert.equal(c, arr[0].child);
});

test('Electron: "can handle cyclic references"', () => {
  const array = [5];
  array.push(array);
  const child = { hello: 'world' };
  child.child = child;
  const [a, ch] = wire([array, child]);
  assert.equal(a[0], 5);
  assert.equal(a[1], a);
  assert.equal(ch.hello, 'world');
  assert.equal(ch.child, ch);
  const m = new Map();
  m.set('self', m);
  const s = new Set();
  s.add(s);
  const e = new Error('e');
  e.cause = e;
  const out = wire({ m, s, e });
  assert.equal(out.m.get('self'), out.m);
  assert.ok(out.s.has(out.s));
  assert.equal(out.e.cause, out.e);
});

test('Electron: "should work when sending an object containing id property"', () => {
  same({ id: 1, name: 'ly' });
});

test('a class instance is sent as a plain object: own enumerable string keys, prototype dropped; getters are read', () => {
  class P {
    constructor() {
      this.a = 1;
      this[Symbol('s')] = 2;
    }
    get g() {
      return 3;
    }
    method() {}
  }
  Object.defineProperty(P.prototype, 'hidden', { value: 1, enumerable: true });
  const o = { x: 1 };
  Object.defineProperty(o, 'getter', { get: () => 'got', enumerable: true });
  Object.defineProperty(o, 'hidden', { value: 'no', enumerable: false });
  const out = wire([new P(), o]);
  assert.deepStrictEqual(out[0], { a: 1 });
  assert.equal(Object.getPrototypeOf(out[0]), Object.prototype);
  assert.deepStrictEqual(out[1], { x: 1, getter: 'got' });
  same([new P(), o]);
});

test('keys that are special to JavaScript or to the codec', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "a": 1}');
  const out = wire(evil);
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'the prototype is not replaced');
  assert.equal({}.polluted, undefined);
  assert.deepStrictEqual(Object.keys(out), ['__proto__', 'constructor', 'a']);
  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(out, '__proto__').value, { polluted: true });

  const withTag = { [TAG]: 'num', v: 'NaN', other: 1 };
  assert.deepStrictEqual(wire(withTag), withTag, 'an object that looks like a codec tag is still data');
  assert.deepStrictEqual(wire({ [TAG]: 'undef' }), { [TAG]: 'undef' });
  assert.deepStrictEqual(wire([{ [TAG]: 'ref', i: 0 }]), [{ [TAG]: 'ref', i: 0 }]);
});

test('Electron: "throws when sending objects with DOM class prototypes" and what V8 refuses: functions, symbols, promises, weak collections', () => {
  const refused = {
    function: [() => 1, /^\(\) => 1 could not be cloned\.$/],
    'named function': [function f() {}, /^function f\(\) \{\} could not be cloned\.$/],
    symbol: [Symbol('s'), /^Symbol\(s\) could not be cloned\.$/],
    promise: [Promise.resolve(), /^#<Promise> could not be cloned\.$/],
    weakmap: [new WeakMap(), /^#<WeakMap> could not be cloned\.$/],
    weakset: [new WeakSet(), /^#<WeakSet> could not be cloned\.$/],
    proxy: [new Proxy({}, {}), /could not be cloned\.$/],
    'a function inside': [{ a: [1, { b: () => 2 }] }, /could not be cloned\.$/],
    'a symbol object': [Object(Symbol('q')), /could not be cloned\.$/],
    'a shared array buffer': [new SharedArrayBuffer(4), /^#<SharedArrayBuffer> could not be cloned\.$/],
    'a generator object': [(function* () {})(), /could not be cloned\.$/],
    'a map iterator': [new Map().keys(), /could not be cloned\.$/],
  };
  for (const [name, [value, message]] of Object.entries(refused)) {
    assert.throws(() => encode(value), (e) => e instanceof Error && !(e instanceof TypeError) && message.test(e.message), name);
    // (a SharedArrayBuffer clones inside one process, by sharing; it cannot cross to another one, which is what Electron's IPC and this bridge are)
    if (!(value instanceof SharedArrayBuffer)) assert.throws(() => structuredClone(value), /could not be cloned|DataCloneError/, `${name}: structuredClone refuses it too`);
  }
});

test('the message for a refused value is the one structuredClone (V8) gives', () => {
  for (const v of [() => 1, function f() {}, Symbol('s'), Promise.resolve(), new WeakMap(), new WeakSet()]) {
    let theirs;
    try {
      structuredClone(v);
    } catch (e) {
      theirs = e.message;
    }
    let ours;
    try {
      encode(v);
    } catch (e) {
      ours = e.message;
    }
    assert.equal(ours, theirs);
  }
});

test('payload sizes (Electron: "round trips strings, typed arrays and nested objects of each size")', () => {
  for (const n of [0, 1, 65535, 65536, 65537, 256 * 1024 + 3, 3 * 1024 * 1024 + 1]) {
    const text = `<${'x'.repeat(n)}>`;
    const bytes = new Uint8Array(n).map((_, i) => (i * 7) & 255);
    const meta = { n, list: [1, 'two', { three: true }] };
    const out = wire([text, bytes, { text, bytes, meta }]);
    assert.equal(out[0], text);
    assert.deepStrictEqual(out[1], bytes);
    assert.equal(out[2].text, text);
    assert.deepStrictEqual(out[2].bytes, bytes);
    assert.deepStrictEqual(out[2].meta, meta);
  }
});

test('arguments lists: undefined arguments keep their place', () => {
  const out = wire(['channel', undefined, null, 0, undefined]);
  assert.equal(out.length, 5);
  assert.ok(out[1] === undefined && out[4] === undefined);
  assert.equal(out[2], null);
});

test('holes in arrays become undefined; non-index properties of an array are dropped (documented differences)', () => {
  const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const out = wire(sparse);
  assert.equal(out.length, 3);
  assert.equal(out[1], undefined);
  const arr = [1, 2];
  arr.extra = 'x';
  assert.deepStrictEqual(wire(arr), [1, 2]);
});

test('nesting: deep but sane data works, past MAX_DEPTH it is refused instead of overflowing the stack', () => {
  let v = 'leaf';
  for (let i = 0; i < 500; i++) v = [v];
  assert.deepStrictEqual(wire(v), v);
  let deep = 'leaf';
  for (let i = 0; i < MAX_DEPTH + 50; i++) deep = [deep];
  assert.throws(() => encode(deep), RangeError);
  // and on the way in: a hostile core cannot make the launcher recurse without end
  let json = 'leaf';
  for (let i = 0; i < MAX_DEPTH + 50; i++) json = [json];
  assert.throws(() => decode(json), TypeError);
});

test('decode refuses what encode cannot have produced (a hostile or broken core), with a TypeError and no side effect', () => {
  const bad = [
    { [TAG]: 'nope' },
    { [TAG]: 'num', v: 'abc' },
    { [TAG]: 'bigint', v: '1.5' },
    { [TAG]: 'bigint', v: 12 },
    { [TAG]: 'ref', i: 0 },
    { [TAG]: 'ref', i: -1 },
    { [TAG]: 'ref', i: 1.5 },
    [{ [TAG]: 'ref', i: 9 }],
    { [TAG]: 'date', v: 'x' },
    { [TAG]: 'regexp', s: '(', f: '' },
    { [TAG]: 'regexp', s: 'a', f: 'zz' },
    { [TAG]: 'ab', b: 5 },
    { [TAG]: 'view', t: 'Function', b: { [TAG]: 'ab', b: '' }, o: 0, l: 0 },
    { [TAG]: 'view', t: 'Uint8Array', b: 'not a buffer', o: 0, l: 0 },
    { [TAG]: 'view', t: 'Uint32Array', b: { [TAG]: 'ab', b: 'AAAA' }, o: 1, l: 1 },
    { [TAG]: 'view', t: 'Uint8Array', b: { [TAG]: 'ab', b: 'AAAA' }, o: 0, l: 99 },
    { [TAG]: 'map', e: [[1]] },
    { [TAG]: 'map', e: 5 },
    { [TAG]: 'set', e: 'x' },
    { [TAG]: 'error', n: 'Object', m: 'x' },
    { [TAG]: 'error', n: 'Error', m: 5 },
    { [TAG]: 'box', t: 'symbol', v: 'x' },
    { [TAG]: 'box', t: 'number', v: 'x' },
    { [TAG]: 'obj', v: [] },
  ];
  for (const b of bad) assert.throws(() => decode(b), TypeError, JSON.stringify(b));
});

test('a cycle through a view or a box does not confuse the numbering', () => {
  const ab = new ArrayBuffer(4);
  const v = { first: new Uint8Array(ab), second: [new Uint8Array(ab, 2, 2)], again: ab, n: new Number(2) };
  v.self = v;
  const out = wire(v);
  assert.equal(out.self, out);
  assert.equal(out.first.buffer, out.second[0].buffer);
  assert.equal(out.first.buffer, out.again);
  assert.equal(out.n.valueOf(), 2);
});

test('randomised: values of every kind equal structuredClone, through JSON', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  function make(depth) {
    const leafs = [() => rnd() * 1000 - 500, () => Math.floor(rnd() * 100), () => 'str' + Math.floor(rnd() * 1000), () => rnd() < 0.5, () => null, () => undefined, () => NaN, () => -0, () => 10n ** 20n, () => new Date(Math.floor(rnd() * 1e12)), () => /x/g, () => new Uint8Array([1, 2, 3]), () => new Float64Array([1.5, 2.5]), () => new ArrayBuffer(3), () => Buffer.from([4, 5, 6])];
    if (depth <= 0) return pick(leafs)();
    switch (Math.floor(rnd() * 5)) {
      case 0:
        return Array.from({ length: Math.floor(rnd() * 4) }, () => make(depth - 1));
      case 1: {
        const o = {};
        for (let i = 0, n = Math.floor(rnd() * 4); i < n; i++) o['k' + i] = make(depth - 1);
        return o;
      }
      case 2:
        return new Map(Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => ['m' + i, make(depth - 1)]));
      case 3:
        return new Set(Array.from({ length: Math.floor(rnd() * 3) }, () => make(depth - 1)));
      default:
        return pick(leafs)();
    }
  }
  for (let i = 0; i < 300; i++) same(make(4), `case ${i}`);
});
