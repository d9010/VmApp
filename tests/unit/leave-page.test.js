'use strict';
// "Leave this page?" for app windows (SPEC 7, DEV-APPS §11 step 18): the loader's wording and the decision per window
// (loader/src/leave-page.js). The real window, the native sheet and the unload itself are tested in loader-cdp run U.
const test = require('node:test');
const assert = require('node:assert/strict');
const { leaveText, createLeaveGuard, LEAVE_QUIET_MS } = require('../../loader/src/leave-page');

test('the question is the loader\'s, names the app, and Stay is the default and Escape', () => {
  const t = leaveText('Code\u0007 OSS');
  assert.equal(t.title, 'Leave this page?');
  assert.equal(t.message, '“Code  OSS” asks you to confirm: changes you made may not be saved.');
  assert.deepEqual([...t.buttons], ['Leave', 'Stay']);
  assert.equal(t.defaultId, 1);
  assert.equal(t.cancelId, 1);
  assert.ok(leaveText('x'.repeat(500)).message.length < 140, 'a long name is cut');
});

test('Leave unloads, Stay keeps the page, and a veto again right after Stay stays without asking', () => {
  let clock = 1000;
  const answers = [false, true, false];
  const asked = [];
  const onVeto = createLeaveGuard({ appName: 'A', now: () => clock, ask: (text) => (asked.push(text.message), answers.shift()) });
  assert.deepEqual(onVeto(), { leave: false, asked: true }, 'Stay');
  clock += 10;
  assert.deepEqual(onVeto(), { leave: false, asked: false }, 'again at once: no second question');
  clock += LEAVE_QUIET_MS - 20;
  assert.deepEqual(onVeto(), { leave: false, asked: false }, 'still inside the quiet time');
  clock += 20;
  assert.deepEqual(onVeto(), { leave: true, asked: true }, 'after the quiet time it asks again: Leave');
  assert.deepEqual(onVeto(), { leave: false, asked: true }, 'Leave starts no quiet time');
  assert.equal(asked.length, 3);
});

test('only an explicit true leaves', () => {
  for (const a of [undefined, null, 0, 1, 'leave', {}]) {
    assert.deepEqual(createLeaveGuard({ appName: 'A', ask: () => a })(), { leave: false, asked: true }, String(a));
  }
});
