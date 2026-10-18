'use strict';
// The loader's wording for host-capability dialogs (loader/src/host-text.js): pure functions, no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../loader/src/host-text');

const app = { id: 'dev.x.agent', name: 'Agent' };
const base = { app, purpose: '', shell: false };

test('confirm: a screenshot is a question the USER answers by picking; the app’s parameters are only a suggestion', () => {
  let c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', params: { target: 'display' } });
  assert.equal(c.message, '“Agent” wants to take a screenshot of something on your screen');
  assert.deepEqual(c.buttons, ['Deny', 'Allow once', 'Allow while the app runs']);
  assert.match(c.detail, /You choose what it gets: a whole display, one window or a part of a screen\. It receives only what you pick\./);
  assert.match(c.detail, /It suggests: your main display\./);
  assert.match(c.detail, /Allow while the app runs: later screenshots need no question, and show what the app asks for then .* not what you pick now\./);
  // the suggestion is named by display, window (by title) or region
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', params: { target: 'display', display: 2 } }, { displays: [{ display: 2, name: 'External Monitor', bounds: { x: 0, y: 0, w: 1920, h: 1080 } }] });
  assert.match(c.detail, /It suggests: display “External Monitor” \(1920 × 1080\)\./);
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', params: { target: 'display', display: 9 } });
  assert.match(c.detail, /It suggests: display 9\./);
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', params: { target: 'window', windowId: 7 } }, { windows: [{ windowId: 7, app: 'Notes', title: 'Shopping list' }] });
  assert.match(c.detail, /It suggests: the window “Shopping list” of Notes\./);
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', params: { target: 'window', windowId: 99 } }, { windows: [] });
  assert.match(c.detail, /It suggests: window number 99\./);
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', params: { target: 'region', region: { x: 10, y: 20, w: 300, h: 200 } } });
  assert.match(c.detail, /It suggests: a part of your screen \(300 × 200 points at 10, 20\)\./);
  // the broker's validated suggestion wins over the raw params; without either (an older broker) the clipped detail is parsed
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', params: { target: 'window', windowId: 1 }, suggestion: { target: 'display' } });
  assert.match(c.detail, /It suggests: your main display\./);
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.capture', detail: 'capture the screen: {"target":"region","region":{"x":1,"y":2,"w":3,"h":4}}' });
  assert.match(c.detail, /\(3 × 4 points at 1, 2\)/);
  c = T.confirmText({ ...base, cap: 'screen', op: 'host.screen.windows' });
  assert.equal(c.message, '“Agent” wants to see which windows are open on your screen');
});

test('what the user picked and a display are named plainly', () => {
  assert.equal(T.displayLabel({ display: 2, name: 'External Monitor', bounds: { x: 1440, y: 0, w: 1920, h: 1080 }, main: false }), '“External Monitor” (1920 × 1080)');
  assert.equal(T.displayLabel({ display: 1, name: 'Built-in', bounds: { x: 0, y: 0, w: 1440, h: 900 }, main: true }), '“Built-in” (1440 × 900), main display');
  assert.equal(T.pickedWhat({ kind: 'region', region: { x: 5, y: 6, w: 70, h: 80 } }), 'a part of your screen (70 × 80 points at 5, 6)');
  assert.equal(T.pickedWhat({ kind: 'window', windowId: 8 }, { windows: [{ windowId: 8, app: 'Notes', title: 'Shopping list' }] }), 'the window “Shopping list” of Notes');
  assert.equal(T.pickedWhat({ kind: 'display', display: 2 }), 'display 2');
});

const SHOW = { showTyped: true };

test('overlay captions: key combinations are always shown; typed text is MASKED by default', () => {
  // combinations and named keys: shown, with or without the setting
  for (const opts of [undefined, {}, SHOW]) {
    assert.equal(T.keyCaption({ kind: 'keys', key: 's', modifiers: ['cmd'] }, opts), '⌘S');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'z', modifiers: ['cmd', 'shift'] }, opts), '⇧⌘Z', 'macOS order: Control, Option, Shift, Command');
    assert.equal(T.keyCaption({ kind: 'keys', key: '.', modifiers: ['cmd', 'alt', 'ctrl'] }, opts), '⌃⌥⌘.');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'a', modifiers: ['ctrl'] }, opts), '⌃A', 'a letter with Control is a shortcut, not text');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'x', modifiers: ['alt'] }, opts), '⌥X');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'return' }, opts), '↩');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'Escape' }, opts), '⎋');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'tab' }, opts), '⇥');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'pagedown' }, opts), 'Page Down');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'delete' }, opts), '⌫');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'f5', modifiers: [] }, opts), 'F5');
    assert.equal(T.keyCaption({ kind: 'keys', key: 'left' }, opts), '←');
  }
  // typed text: "typing… (N characters)" unless the user turned "Show typed text in the overlay" on
  assert.equal(T.keyCaption({ kind: 'keys', text: 'Hello' }), 'typing… (5 characters)');
  assert.equal(T.keyCaption({ kind: 'keys', text: 'hunter2' }, {}), 'typing… (7 characters)', 'a password is never readable');
  assert.ok(!/hunter/.test(T.keyCaption({ kind: 'keys', text: 'hunter2' })));
  assert.equal(T.keyCaption({ kind: 'keys', text: 'x' }), 'typing… (1 character)', 'singular');
  assert.equal(T.keyCaption({ kind: 'keys', text: 'Hello, world! This is a long sentence that goes on' }), 'typing… (50 characters)', 'the count is the whole text, not the first 28');
  assert.equal(T.keyCaption({ kind: 'keys', text: 'a\nb\tc\u0007d' }), 'typing… (6 characters)', 'newline and tab count as one character each; control characters are dropped');
  assert.equal(T.keyCaption({ kind: 'keys', text: '😀'.repeat(40) }), 'typing… (40 characters)', 'characters, not UTF-16 units');
  assert.equal(T.keyCaption({ kind: 'keys', text: '\u0007' }), null, 'nothing typed, nothing to show');
  assert.equal(T.keyCaption({ kind: 'keys', text: '' }), null);
  // one plain key press is typed text too: a script cannot get around the mask one key at a time
  assert.equal(T.keyCaption({ kind: 'keys', key: 'p' }), 'typing… (1 character)');
  assert.equal(T.keyCaption({ kind: 'keys', key: 'P', modifiers: ['shift'] }), 'typing… (1 character)', 'Shift only changes the letter');
  assert.equal(T.keyCaption({ kind: 'keys', key: '7' }), 'typing… (1 character)');
  assert.equal(T.keyCaption({ kind: 'keys', key: 'space' }), 'typing… (1 character)');
  assert.equal(T.keyCaption({ kind: 'keys', key: 'é' }), 'typing… (1 character)');
  // the counts the overlay adds up: typedLength is 0 for combinations and named keys
  assert.equal(T.typedLength({ kind: 'keys', text: 'abc' }), 3);
  assert.equal(T.typedLength({ kind: 'keys', key: 's', modifiers: ['cmd'] }), 0);
  assert.equal(T.typedLength({ kind: 'keys', key: 's', modifiers: ['shift', 'cmd'] }), 0);
  assert.equal(T.typedLength({ kind: 'keys', key: 'return' }), 0);
  assert.equal(T.typedLength({ kind: 'keys', key: 'f5' }), 0);
  assert.equal(T.typedLength({ kind: 'keys', key: 'ab' }), 0);
  assert.equal(T.typedLength(null), 0);
  assert.equal(T.typedLength({ kind: 'mouse' }), 0);
  assert.equal(T.typedCaption(12), 'typing… (12 characters)');
});

test('overlay captions with "Show typed text in the overlay" on: the first 28 characters, cut short', () => {
  assert.equal(T.keyCaption({ kind: 'keys', text: 'Hello' }, SHOW), 'Hello');
  const long = T.keyCaption({ kind: 'keys', text: 'Hello, world! This is a long sentence that goes on' }, SHOW);
  assert.equal(long, 'Hello, world! This is a long…');
  assert.equal([...long].length, 29, '28 characters and an ellipsis');
  assert.equal(T.keyCaption({ kind: 'keys', text: 'a\nb\tc\u0007d' }, SHOW), 'a↩b⇥cd', 'newline and tab get glyphs, control characters are dropped');
  assert.equal(T.keyCaption({ kind: 'keys', text: '😀'.repeat(40) }, SHOW), `${'😀'.repeat(28)}…`, 'never cuts a character in half');
  assert.equal(T.keyCaption({ kind: 'keys', text: '\u0007' }, SHOW), null);
  assert.equal(T.keyCaption({ kind: 'keys', key: 'p' }, SHOW), 'P', 'a single key shows as the key');
  assert.equal(T.keyCaption({ kind: 'keys', key: 'space' }, SHOW), 'Space');
  assert.equal(T.keyCaption(null), null);
  assert.equal(T.keyCaption({ kind: 'keys' }), null);
  assert.equal(T.keyCaption({ kind: 'keys' }, SHOW), null);
  // an option object that is not exactly `showTyped: true` does not unmask
  for (const bad of [{ showTyped: 'yes' }, { showTyped: 1 }, { showtyped: true }, { showTyped: false }, null, 'true']) {
    assert.equal(T.keyCaption({ kind: 'keys', text: 'abc' }, bad), 'typing… (3 characters)', `${JSON.stringify(bad)} keeps the mask`);
  }
  assert.equal(T.mouseCaption({ action: 'scroll', dy: 300 }), 'Scroll ↓');
  assert.equal(T.mouseCaption({ action: 'scroll', dy: -300 }), 'Scroll ↑');
  assert.equal(T.mouseCaption({ action: 'scroll', dx: -40, dy: 5 }), 'Scroll ←');
  assert.equal(T.mouseCaption({ action: 'click', x: 1, y: 2 }), null, 'a click is drawn as a ripple, not written');
});

test('confirm: the purpose is quoted, never merged into the sentence', () => {
  const c = T.confirmText({ ...base, purpose: 'Reads the screen to help you fill forms', cap: 'screen', op: 'host.screen.capture', params: {} });
  assert.match(c.detail, /^Why the app says it needs this: “Reads the screen to help you fill forms”/);
  assert.ok(!c.message.includes('fill forms'));
});

test('confirm: a tool run shows the tool name, the program and every argument quoted', () => {
  const tool = { id: 'echo', name: 'Echo tool', path: '/bin/echo', kind: 'tool' };
  const c = T.confirmText({ ...base, cap: 'tool:echo', op: 'host.tool.run', params: { id: 'echo', args: ['hello world', '-n; rm -rf /'] } }, { tool });
  assert.equal(c.message, '“Agent” wants to run the tool “Echo tool”');
  assert.equal(c.shell, false);
  assert.match(c.detail, /Program: \/bin\/echo/);
  assert.match(c.detail, /1\. "hello world"\n {2}2\. "-n; rm -rf \/"/);
  assert.ok(!c.detail.includes('Shortened'));
});

test('confirm: a shell tool is labelled as a shell and warned about', () => {
  const tool = { id: 'zsh', name: 'Terminal', path: '/bin/zsh', kind: 'shell' };
  const c = T.confirmText({ ...base, cap: 'tool:zsh', op: 'host.tool.run', shell: true, params: { id: 'zsh', args: ['-c', 'ls ~'] } }, { tool });
  assert.equal(c.message, '“Agent” wants to run a shell command (“Terminal”)');
  assert.equal(c.shell, true);
  assert.match(c.detail, /A shell can do anything you can do on this Mac/);
  assert.match(c.detail, /1\. "-c"\n {2}2\. "ls ~"/);
});

test('confirm: long arguments are cut and say so; control characters never reach the dialog', () => {
  const long = 'x'.repeat(5000);
  const c = T.confirmText({ ...base, cap: 'tool:zsh', op: 'host.tool.run', shell: true, params: { id: 'zsh', args: ['-c', long, 'a\u0007b\u001b[2Jc'] } }, { tool: { id: 'zsh', name: 'Terminal', path: '/bin/zsh', kind: 'shell' } });
  assert.match(c.detail, /first 600 of 5000 characters/);
  assert.match(c.detail, /Shortened here/);
  assert.ok(c.detail.length < 4000);
  assert.ok(!/[\u0007\u001b]/.test(c.detail));
  const many = T.confirmText({ ...base, cap: 'tool:e', op: 'host.tool.run', params: { id: 'e', args: Array.from({ length: 50 }, (_, i) => String(i)) } });
  assert.match(many.detail, /… and 30 more/);
});

test('confirm: input control mentions the badge and the panic shortcut; the reason is quoted', () => {
  const c = T.confirmText({ ...base, cap: 'input', op: 'host.input.start', params: { reason: 'click the Save button' } });
  assert.equal(c.message, '“Agent” wants to control your mouse and keyboard');
  assert.match(c.detail, /“click the Save button”/);
  assert.match(c.detail, /red bar.*Stop button.*Control-Option-Command-period/);
});

test('confirm: MCP names the server and the tool', () => {
  const server = { id: 'vscode', name: 'VS Code', command: ['/usr/local/bin/code-mcp', '--stdio'] };
  let c = T.confirmText({ ...base, cap: 'mcp:vscode', op: 'host.mcp.call', params: { server: 'vscode', method: 'tools/call', params: { name: 'open_file', arguments: { path: '/tmp/a.txt' } } } }, { server });
  assert.equal(c.message, '“Agent” wants to use the tool “open_file” of VS Code');
  assert.match(c.detail, /Arguments: \{"path":"\/tmp\/a\.txt"\}/);
  assert.match(c.detail, /Program: \/usr\/local\/bin\/code-mcp --stdio/);
  c = T.confirmText({ ...base, cap: 'mcp:vscode', op: 'host.mcp.call', params: { server: 'vscode', method: 'resources/list' } }, { server });
  assert.equal(c.message, '“Agent” wants to ask VS Code for something (resources/list)');
  c = T.confirmText({ ...base, cap: 'mcp:vscode', op: 'host.mcp.list' }, { server });
  assert.equal(c.message, '“Agent” wants to start VS Code and see which tools it offers');
});

test('the app name is cleaned and cut', () => {
  const c = T.confirmText({ ...base, app: { id: 'a', name: `Evil\u0007${'N'.repeat(100)}` }, cap: 'screen', op: 'host.screen.windows' });
  assert.ok(!c.message.includes('\u0007'));
  assert.ok(c.message.length < 150);
});

test('labels, badge text and the INV-H6 label', () => {
  assert.match(T.capLabel('screen'), /^See your screen/);
  assert.equal(T.capLabel('input'), 'Control your mouse and keyboard');
  assert.match(T.capLabel('tool:*'), /you pick which/);
  assert.equal(T.capLabel('tool:echo'), 'Run the tool “echo” from your catalog');
  assert.equal(T.capLabel('mcp:vscode'), 'Use the MCP server “vscode” from your catalog');
  assert.equal(T.badgeText({ kind: 'input', appName: 'Agent' }), 'Agent is controlling your computer');
  assert.equal(T.badgeText({ kind: 'shell', appName: 'Agent' }), 'Agent is running a shell command');
  assert.equal(T.controlLabel([{ cap: 'screen', control: false }]), null);
  assert.equal(T.controlLabel([{ cap: 'screen', control: false }, { cap: 'input', control: true }]), 'requests control of your computer');
  assert.equal(T.controlLabel([]), null);
});
