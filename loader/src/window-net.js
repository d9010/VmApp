'use strict';
// The network of an app's windows (SPEC 7, 8.3 "The app's windows", DEV-APPS C3): which requests the app partition's request filter
// lets out beside its own schemes (window-manager.js allowedSchemes).
//
// Only for a run that has a window endpoint (`state`: the app declares the window feature "network", and vmapp-vm started the
// endpoint for this run), and then only https: and wss: requests for DATA (fetch and XHR, WebSocket, images, media, fonts, style
// sheets) to a host NAME. They leave through the partition's proxy, the app's own endpoint in vmapp-vm, which applies the app's
// network rules (nothing without the user's grant), the address check and the limits, and reports every connection (INV-N1 to N4).
// Never code or documents from the network (scripts, frames, objects, workers), never http: or ws:, never credentials in a URL,
// never an IP address or a name of this machine or the local network; nothing at all without the endpoint.
//
// Self-contained on purpose (no require, only the URL global): tools/check-invariants evaluates this file and runs its own vectors
// against windowNetAllowed (rule b3-renderer-csp).

const NET_SCHEMES = Object.freeze(['https:', 'wss:']);
const NET_TYPES = Object.freeze(['xhr', 'webSocket', 'image', 'media', 'font', 'stylesheet']);
// the names of this machine or a local network (as in host/src/net.rs LOCAL_TLDS); the endpoint refuses them too
const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|lan|home\.arpa)$/;

/**
 * May this request of an app window leave through the app's window endpoint? `state` is the run's endpoint (or null), `details`
 * the request filter's details ({url, resourceType}).
 */
function windowNetAllowed(state, details) {
  if (!state || !Number.isInteger(state.port) || !details || typeof details.url !== 'string') return false;
  if (!NET_TYPES.includes(details.resourceType)) return false;
  let u;
  try {
    u = new URL(details.url);
  } catch {
    return false;
  }
  if (!NET_SCHEMES.includes(u.protocol) || u.username || u.password) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const last = host.split('.').pop();
  // a name with at least two labels whose last one starts with a letter: no IPv4 address in any spelling (the URL parser already
  // turned 0x7f.1 into 127.0.0.1), no bracketed IPv6 address, no single-label name
  if (!host.includes('.') || host.includes('[') || host.includes(':') || !/^[a-z]/.test(last)) return false;
  if (LOCAL_NAME.test(host)) return false;
  return true;
}

module.exports = { windowNetAllowed, NET_SCHEMES, NET_TYPES };
