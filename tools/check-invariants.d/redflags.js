'use strict';
// docs/REVIEWING.md step 4: the red-flag scan, run on ADDED lines of a diff (and, for removals, on removed lines).
// A hit is not automatically wrong: each needs a justification the reviewer has verified.

const inDir = (...dirs) => (f) => dirs.some((d) => f.startsWith(d));
const isCode = (f) => /\.(m?js|cjs|rs|m|mm|h|c|json|sh|html|toml|swift|py)$|(^|\/)Dockerfile|\.Dockerfile$|(^|\/)(mkruntime|mkcpio|vmapp|check-invariants)$/.test(f);
const loaderOrHostlib = (f) => inDir('loader/', 'hostlib/')(f) && /\.(m?js|cjs|html)$/.test(f) && !/(^|\/)test\//.test(f);
const any = () => true;

/** Lines that are only a comment in common syntaxes. */
const isCommentLine = (t) => /^\s*(\/\/|\/\*|\*|#|<!--)/.test(t);

const FLAGS = [
  // renderer settings
  { cat: 'renderer-settings', invs: ['INV-B1'], when: isCode, re: /\bnodeIntegration(?:InWorker|InSubFrames)?\s*:\s*true\b/, what: 'nodeIntegration enabled' },
  { cat: 'renderer-settings', invs: ['INV-B1'], when: isCode, re: /\bsandbox\s*:\s*false\b/, what: 'sandbox: false' },
  { cat: 'renderer-settings', invs: ['INV-B1'], when: isCode, re: /\bcontextIsolation\s*:\s*false\b/, what: 'contextIsolation: false' },
  { cat: 'renderer-settings', invs: ['INV-B1'], when: isCode, re: /\bwebSecurity\s*:\s*false\b/, what: 'webSecurity: false' },
  { cat: 'renderer-settings', invs: ['INV-B1'], when: loaderOrHostlib, re: /\bdevTools\s*:\s*(?!(?:[\w$]+\s*\.\s*devTools\s*===\s*true|!\s*(?:this\s*\.\s*)?cfg\s*\.\s*isPackaged)[\s,})\];]*$)/, what: 'webPreferences.devTools set to anything but the core\'s window.create value (apps) or !cfg.isPackaged (loader windows)' },
  { cat: 'renderer-settings', invs: ['INV-B1'], when: isCode, re: /\bwebviewTag\s*:\s*true\b|<webview\b/, what: 'webview enabled' },
  { cat: 'renderer-settings', invs: ['INV-B1'], when: isCode, re: /\ballowRunningInsecureContent\s*:\s*(?!false\b)/, what: 'allowRunningInsecureContent not false' },
  { cat: 'renderer-settings', invs: ['INV-B1'], when: loaderOrHostlib, re: /\b(?:new\s+)?(?:BrowserWindow|WebContentsView|BrowserView)\s*\(/, what: 'new window/view constructed (is it for app content? B1 applies)' },
  // CSP
  { cat: 'csp', invs: ['INV-B3'], when: isCode, re: /unsafe-eval/, what: 'unsafe-eval' },
  { cat: 'csp', invs: ['INV-B3'], when: isCode, re: /script-src[^;"'`]*'unsafe-inline'/, what: "unsafe-inline in script-src" },
  { cat: 'csp', invs: ['INV-B3'], when: isCode, re: /connect-src\s+(?!'none')\S/, what: "connect-src other than 'none'" },
  { cat: 'csp', invs: ['INV-B3'], when: isCode, re: /(?:default|script|style|img|media|font|connect|frame|object|child|worker)-src[^;"'`\n]*\s\*(?=[\s;"'`]|$)/, what: '* in a CSP directive' },
  // code execution in loader/ hostlib/
  { cat: 'code-exec', invs: ['INV-A1'], when: loaderOrHostlib, re: /(?<![\w$])eval\s*\(/, what: 'eval(' },
  { cat: 'code-exec', invs: ['INV-A1'], when: loaderOrHostlib, re: /(?<![\w$.])(?:new\s+)?Function\s*\(/, what: 'Function constructor' },
  { cat: 'code-exec', invs: ['INV-A1'], when: loaderOrHostlib, re: /\bvm\s*\.\s*runIn\w+|\brunIn(?:This|New)Context\b|\bvm\s*\.\s*Script\b|\bcompileFunction\b/, what: 'vm code execution' },
  { cat: 'code-exec', invs: ['INV-A1'], when: loaderOrHostlib, re: /(?<![\w$.])(?:require|import)\s*\(\s*(?!['"][^'"]*['"]\s*\))/, what: 'require()/import() with a non-literal argument' },
  // processes and the OS
  { cat: 'processes', invs: ['INV-A1'], when: loaderOrHostlib, re: /child_process|(?<![\w$.])(?:exec|execSync|execFile|execFileSync|fork|spawn|spawnSync)\s*\(|\.\s*(?:exec|execSync|execFile|spawn)\s*\((?!\s*\))/, what: 'child process API (only spawning vmapp-vm with platform-built arguments is allowed)' },
  { cat: 'processes', invs: ['INV-A1', 'INV-B5'], when: loaderOrHostlib, re: /\bshell\s*\.\s*(?:openPath|openExternal|showItemInFolder|trashItem)\b/, what: 'shell.openPath / openExternal (needs the confirm path)' },
  // permissions
  { cat: 'permissions', invs: ['INV-B3'], when: loaderOrHostlib, re: /\bsetPermission(?:Request|Check)Handler\b|\bsetDevicePermissionHandler\b/, what: 'permission handler touched (must still deny everything)' },
  { cat: 'permissions', invs: ['INV-B3'], when: loaderOrHostlib, re: /\bcallback\s*\(\s*true\s*\)|\bcb\s*\(\s*true\s*\)/, what: 'permission callback(true)' },
  { cat: 'permissions', invs: ['INV-B3'], when: loaderOrHostlib, re: /\bsession\s*\.\s*defaultSession\b/, what: 'session.defaultSession (never for app content)' },
  { cat: 'permissions', invs: ['INV-B2', 'INV-C1'], when: inDir('loader/'), re: /\bipcMain\s*\.\s*(?:handle|handleOnce|on|once)\s*\(/, what: 'new ipcMain handler (reachable from app renderers unless it checks the sender)' },
  { cat: 'permissions', invs: ['INV-B3'], when: inDir('loader/'), re: /\bsetWindowOpenHandler\b|will-navigate|will-frame-navigate|will-redirect/, what: 'navigation/popup guard touched' },
  // VM networking
  { cat: 'vm-network', invs: ['INV-D1'], when: inDir('host/'), re: /VZ\w*Network\w*|networkDevices|com\.apple\.vm\.networking/i, what: 'VM network device / attachment' },
  // network permission (SPEC 8.3): the proxy is the only way out and it checks every address
  { cat: 'network-egress', invs: ['INV-N1', 'INV-N3'], when: (f) => inDir('guest/')(f) || (inDir('host/src/')(f) && f !== 'host/src/net.rs'), re: /\bTcpStream\s*::\s*connect\w*\s*\(|\bUdpSocket\b|\bto_socket_addrs\b|(?<![\w$:])libc\s*::\s*(?:connect|sendto|sendmsg)\s*\(/, what: 'outbound socket or name lookup outside host/src/net.rs (all app network goes through the checked proxy)' },
  { cat: 'network-proxy', invs: ['INV-N3'], when: (f) => f === 'host/src/net.rs', re: /\bconnect_timeout\b|\bfn\s+(?:is_forbidden_ip|check_addresses|forbidden_v[46]|valid_hostname|normalize_request_host)\b|\bMAX_CONNECTIONS\b|\ballow_loopback\b/, what: 'address check, name rules or connection cap touched (every address must still be checked before connect)' },
  { cat: 'network-switch', invs: ['INV-N3'], when: (f) => (inDir('loader/')(f) || inDir('hostlib/')(f)) && f !== 'hostlib/session.js' && !/(^|\/)test\//.test(f), re: /dev-allow-loopback|dev-resolve|allowLoopback|devNet/, what: 'network test switch outside hostlib/session.js (never in the loader)' },
  // privilege in the guest
  { cat: 'guest-privilege', invs: ['INV-D4'], when: inDir('guest/'), re: /\bset(?:e)?(?:u|g)id\s*\(\s*0\s*\)|\bsetres(?:u|g)id\s*\(\s*0/, what: 'setuid(0)/setgid(0)' },
  { cat: 'guest-privilege', invs: ['INV-D4'], when: inDir('guest/'), re: /MS_REMOUNT(?![^;\n]*MS_RDONLY)/, what: 'MS_REMOUNT without MS_RDONLY on the same line' },
  { cat: 'guest-privilege', invs: ['INV-D4', 'INV-D5'], when: inDir('guest/'), re: /(?<![\w$:])(?:mount|mount_logged|bind)\s*\(/, what: 'new mount in the guest (new writable mounts are forbidden)' },
  // launcher output
  { cat: 'launcher-output', invs: ['INV-E2'], when: inDir('host/'), re: /(?<![\w$])(?:println|eprintln|print|eprint|dbg)\s*!/, what: 'print macro in the launcher' },
  // package checks
  { cat: 'package-checks', invs: ['INV-F1'], when: (f) => inDir('loader/', 'hostlib/')(f) && !/(^|\/)test\//.test(f), re: /\bskipRuntimeCheck\b/, what: 'skipRuntimeCheck outside tests and the CLI' },
  { cat: 'package-checks', invs: ['INV-F1'], when: (f) => inDir('loader/', 'hostlib/')(f) && !/(^|\/)test\//.test(f), re: /\bforce\s*[:=]\s*(?!false\b)\w|\bforce\s*\)/, what: '`force` option used outside tests and the CLI' },
  { cat: 'package-checks', invs: ['INV-F1', 'INV-B4'], when: (f) => /^hostlib\/(package|manifest|tar|cpio|store)\.js$/.test(f) || f === 'loader/src/protocols.js', re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/, what: 'empty catch {} in verification code' },
  // path handling
  { cat: 'path-handling', invs: ['INV-C3', 'INV-D2'], when: loaderOrHostlib, re: /\bpath\s*\.\s*(?:join|resolve)\s*\([^)]*\b(?:p|params|msg|message|req|request|args|payload|data)\s*\.\s*\w+/, what: 'host path built from a message/param field' },
  { cat: 'path-handling', invs: ['INV-B4', 'INV-C3'], when: loaderOrHostlib, re: /\bpath\s*\.\s*join\s*\(\s*\w*[Rr]oot\w*\s*,/, what: 'path.join(root, ...) (needs a later containment check)' },
  // hygiene
  { cat: 'dependencies', invs: ['INV-A1', 'INV-G3'], when: (f) => /(^|\/)package\.json$/.test(f) && /^(loader|hostlib|sdk)\//.test(f), re: /^\s*"[@\w][\w@/.-]*"\s*:\s*"(?:[\^~<>=]*\d|git|github:|file:|https?:|npm:|workspace:|\*|latest)/, what: 'dependency added/changed in package.json' },
  { cat: 'dependencies', invs: ['INV-F2'], when: (f) => /Cargo\.toml$/.test(f), re: /^\s*[\w-]+\s*=\s*(?:"[^"]*"|\{[^}]*version)/, what: 'Cargo dependency line' },
  { cat: 'network-url', invs: ['INV-G3'], when: (f) => /^(loader|hostlib|sdk|host|guest)\//.test(f) && isCode(f) && !/(^|\/)test\//.test(f), re: /https?:\/\/(?!(?:www\.)?w3\.org\/)[^\s'"`)<>]+/, what: 'new URL', skipComments: true },
  { cat: 'secrets', invs: ['INV-G3'], when: any, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9]{20,}|\bxox[bpa]-[A-Za-z0-9-]{10,}|\b(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, what: 'possible secret/token/key' },
  // instructions aimed at the reviewer
  { cat: 'reviewer-instructions', invs: ['REVIEW'], when: any, re: /\b(?:ignore|disregard|skip|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|review|reviewer|checks?|instructions?|invariants?|governance)\b|\b(?:reviewer|ai reviewer|claude|assistant)\b[^.\n]{0,40}\b(?:approve|lgtm|must approve|should approve|do not (?:flag|report))\b|\bapprove (?:this|it) (?:pr|pull request|change|without)|\bLGTM\b|\bpre-?approved\b|\bdo not (?:flag|report|mention) (?:this|these)/i, what: 'text addressed to the reviewer (approve / skip checks): a red flag in itself' },
];

// Tokens whose removal is a red flag (REVIEWING: "removed PR_SET_NO_NEW_PRIVS", loosened checks).
const REMOVAL_FLAGS = [
  { when: inDir('guest/'), re: /PR_SET_NO_NEW_PRIVS|\bsetgroups\b|\bchroot\b|MS_RDONLY/, invs: ['INV-D4'], what: 'guest privilege/read-only line removed' },
  { when: loaderOrHostlib, re: /createHash\s*\(\s*['"]sha256|\bpermissions\s*\.\s*(?:dialogs|external)\b|preventDefault|action\s*:\s*['"]deny|callback\s*\(\s*false|connect-src/, invs: ['INV-B3', 'INV-B4', 'INV-C2'], what: 'verification / denial line removed' },
  { when: inDir('host/'), re: /kqueue|SIGTERM|SIGHUP|SIGINT|EVFILT_PROC|NOTE_EXIT/, invs: ['INV-E1'], what: 'stop-path line removed' },
  { when: (f) => f === 'host/src/net.rs', re: /check_addresses|is_forbidden_ip|forbidden_v[46]|MAX_CONNECTIONS|normalize_request_host/, invs: ['INV-N3'], what: 'network address check / cap line removed' },
];

/**
 * @param {{file:string,line:number,text:string}[]} added   file relative to vmapp/
 * @param {{file:string,text:string}[]} removed
 */
function scan(added, removed) {
  const hits = [];
  for (const a of added) {
    for (const f of FLAGS) {
      if (!f.when(a.file)) continue;
      if (f.skipComments && isCommentLine(a.text)) continue;
      if (f.re.test(a.text)) hits.push({ category: f.cat, invs: f.invs, file: a.file, line: a.line, text: a.text.trim().slice(0, 200), what: f.what });
    }
  }
  for (const r of removed) {
    for (const f of REMOVAL_FLAGS) {
      if (!f.when(r.file)) continue;
      if (isCommentLine(r.text)) continue;
      if (f.re.test(r.text)) hits.push({ category: 'removed', invs: f.invs, file: r.file, line: r.line || null, text: `- ${r.text.trim().slice(0, 190)}`, what: f.what });
    }
  }
  return hits;
}

module.exports = { scan, FLAGS };
