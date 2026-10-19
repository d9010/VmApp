'use strict';
// "Verified by the operator": the registry's operator can vouch for the publisher of an app (registry-worker: POST
// /api/admin/apps/:id/verify-publisher). The log says so (method "operator"), only the admin can write that, and the presentation
// of a publisher nobody verified is empty, so that what users see is only ever a fact.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, EventError } = require('../../registry/lib/state');
const { publicView, normalizeDomain } = require('../../registry/lib/publisher');

const ev = (over) => Object.assign({ seq: 7, ts: '2026-10-18T12:00:00.000Z', type: 'publisher.verified', actor: 'admin', data: { id: 'pub-0123456789abcdef', kind: 'domain', name: 'd9010.com', method: 'operator' } }, over);

test('a domain verified by the operator is a valid event, from the admin only', () => {
  assert.doesNotThrow(() => validate(ev({})));
  for (const actor of ['pub-0123456789abcdef', 'system', 'someone']) {
    assert.throws(() => validate(ev({ actor })), EventError, `actor ${actor} must not be able to vouch`);
  }
  // the other methods are unchanged, and nothing else is accepted
  assert.doesNotThrow(() => validate(ev({ actor: 'pub-0123456789abcdef', data: { id: 'pub-0123456789abcdef', kind: 'domain', name: 'd9010.com', method: 'file' } })));
  assert.throws(() => validate(ev({ data: { id: 'pub-0123456789abcdef', kind: 'domain', name: 'd9010.com', method: 'trust-me' } })), EventError);
});

test('what a user sees: nothing for an unverified publisher; the label with the company for a verified domain', () => {
  const claims = { name: 'Mallory', company: 'Apple Inc.', email: 'tim@apple.com', url: 'https://apple.com', emailVerified: null, domain: null };
  assert.deepEqual(publicView(claims), { level: 'unverified', label: '' }, 'a claimed company is not shown without a verification');
  const verified = Object.assign({}, claims, { company: 'D9010 Inc', url: 'https://d9010.com', domain: { name: 'd9010.com', method: 'operator', at: 'x' } });
  assert.deepEqual(publicView(verified), { level: 'domain', label: 'Verified: d9010.com', domain: 'd9010.com', company: 'D9010 Inc', url: 'https://d9010.com' });
});

test('the domain the operator names must be a host name', () => {
  assert.equal(normalizeDomain(' D9010.com '), 'd9010.com');
  for (const bad of ['', 'localhost', 'https://d9010.com', 'd9010.com/x', 'a b.com', 7, null]) assert.throws(() => normalizeDomain(bad), /domain/, String(bad));
});
