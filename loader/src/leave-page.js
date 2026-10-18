'use strict';
// "Leave this page?" for app windows (SPEC 7). A page may veto its own unload (a `beforeunload` handler that calls preventDefault
// or sets returnValue); Electron shows no question for that and simply stays. The loader asks instead, in its own words, naming
// the app (INV-B5): the page's returnValue text is never shown. No Electron here, so the decision is unit-tested on its own.

const LEAVE_QUIET_MS = 1000; // after Stay, another veto of the same window within this time stays without asking
const LEAVE_BUTTONS = Object.freeze(['Leave', 'Stay']);

// eslint-disable-next-line no-control-regex
const clean = (s, max = 60) => String(s === undefined ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** The loader's wording of the question (Stay is the default and the answer to Escape). */
function leaveText(appName) {
  return {
    title: 'Leave this page?',
    message: `“${clean(appName)}” asks you to confirm: changes you made may not be saved.`,
    buttons: LEAVE_BUTTONS,
    defaultId: 1,
    cancelId: 1,
  };
}

/**
 * The decision for ONE window's vetoes. `ask(text)` shows the question and returns true for Leave (synchronously: Electron's
 * will-prevent-unload must be answered before its handler returns). Each call of the result is one veto and returns
 * { leave, asked }: leave = ignore the veto and unload (the caller calls event.preventDefault()); asked = false when the veto
 * came again within `quietMs` after Stay, so a page cannot pile up questions.
 */
function createLeaveGuard({ appName, ask, now = Date.now, quietMs = LEAVE_QUIET_MS }) {
  let stayedAt = -Infinity;
  return function onVeto() {
    if (now() - stayedAt < quietMs) return { leave: false, asked: false };
    const leave = ask(leaveText(appName)) === true;
    if (!leave) stayedAt = now();
    return { leave, asked: true };
  };
}

module.exports = { leaveText, createLeaveGuard, LEAVE_QUIET_MS, LEAVE_BUTTONS };
