'use strict';
// Runs right after vmapp-fetch.js and before the page is parsed: what the test needs to know about everything that happens next.
// It is the test's instrument, not part of what is tested: it records Content-Security-Policy violations and the page's own error
// handlers (an app's onerror fallback must run for a picture that really is missing, and must not run for one that is merely on its way).
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI.slice(0, 80)}`));
window.__events = { missingError: 0, fallbackError: 0, fallbackLoad: 0 };
