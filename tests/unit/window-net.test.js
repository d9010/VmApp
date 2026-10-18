'use strict';
// The network of an app's windows (SPEC 8.3 "The app's windows", DEV-APPS C3): which requests the app partition's request filter
// lets out (loader/src/window-net.js). The endpoint itself is tested in host/src/net.rs, the whole path in loader-cdp run W.
const test = require('node:test');
const assert = require('node:assert/strict');
const { windowNetAllowed, NET_SCHEMES, NET_TYPES } = require('../../loader/src/window-net');

const endpoint = Object.freeze({ host: '127.0.0.1', port: 51234, username: 'vmapp', password: 'x'.repeat(64) });
const ask = (url, resourceType, state = endpoint) => windowNetAllowed(state, { url, resourceType });

test('data requests over https and wss to a host name leave, through the endpoint', () => {
  assert.deepEqual([...NET_SCHEMES], ['https:', 'wss:']);
  assert.deepEqual([...NET_TYPES], ['xhr', 'webSocket', 'image', 'media', 'font', 'stylesheet']);
  for (const [url, type] of [
    ['https://open-vsx.org/api/-/search?query=x', 'xhr'],
    ['https://openvsxorg.blob.core.windows.net/resources/icon.png', 'image'],
    ['https://img.shields.io/badge/x.svg', 'image'],
    ['https://cdn.example.com/a.woff2', 'font'],
    ['https://cdn.example.com/a.css', 'stylesheet'],
    ['https://media.example.com/a.mp4', 'media'],
    ['wss://live.example.com/socket', 'webSocket'],
    ['https://API.Example.COM./x', 'xhr'],
    ['https://a.example.com:8443/x', 'xhr'],
  ]) {
    assert.equal(ask(url, type), true, `${type} ${url}`);
  }
});

test('nothing leaves without the run\'s endpoint', () => {
  for (const state of [null, undefined, {}, { port: '51234' }, { port: 1.5 }]) {
    assert.equal(windowNetAllowed(state, { url: 'https://a.example.com/x', resourceType: 'xhr' }), false, JSON.stringify(state));
  }
  assert.equal(windowNetAllowed(endpoint, null), false);
  assert.equal(windowNetAllowed(endpoint, { resourceType: 'xhr' }), false);
});

test('no code or document from the network, whatever the CSP says', () => {
  for (const type of ['script', 'subFrame', 'mainFrame', 'object', 'ping', 'cspReport', 'other', 'unknown', undefined]) {
    assert.equal(ask('https://a.example.com/x', type), false, String(type));
  }
});

test('no other scheme, no address in any spelling, no local name, no credentials in the URL', () => {
  for (const url of [
    'http://a.example.com/x',
    'ws://a.example.com/x',
    'ftp://a.example.com/x',
    'file:///etc/passwd',
    'https://127.0.0.1/',
    'https://127.1/',
    'https://0x7f.1/',
    'https://2130706433/',
    'https://017700000001/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[fe80::1]/',
    'https://192.168.1.10:8443/',
    'https://10.0.0.1/',
    'https://localhost/',
    'https://LOCALHOST./',
    'https://app.localhost/',
    'https://printer.local/',
    'https://db.internal/',
    'https://box.localdomain/',
    'https://nas.lan/',
    'https://router.home.arpa/',
    'https://intranet/',
    'https://user:pw@a.example.com/',
    'https://user@a.example.com/',
    'not a url',
  ]) {
    assert.equal(ask(url, 'xhr'), false, url);
  }
});
