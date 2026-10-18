// Shared by bridge-fetch.test.mjs and bookmarks.mjs: runs examples/convert-webapp/converted/ui/bridge-fetch.js in a
// Node vm context that looks like a vmapp renderer window (location on the vmapp-ui:// scheme, window.vmapp).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_FETCH = path.resolve(HERE, '../../examples/convert-webapp/converted/ui/bridge-fetch.js');

/**
 * @param {(channel: string, ...args: any[]) => Promise<any>} invoke  stands in for window.vmapp.invoke
 * @param {{ withResponse?: boolean, appId?: string }} opts  withResponse:false hides the global Response, which
 *        exercises the built-in MiniResponse fallback.
 * @returns the fake `window` (window.fetch is bridge-fetch's replacement; window.realFetchCalls lists fall-throughs)
 */
export function loadBridgeFetch(invoke, { withResponse = true, appId = 'dev.vmapp.convert.bookmarks' } = {}) {
  const window = {
    vmapp: { invoke },
    location: { href: `vmapp-ui://${appId}/index.html`, protocol: 'vmapp-ui:', host: appId },
    URL,
    URLSearchParams,
    Headers,
    DOMException,
    realFetchCalls: [],
  };
  window.fetch = (input) => {
    window.realFetchCalls.push(String(input));
    return Promise.reject(new TypeError('Failed to fetch (blocked by the CSP)'));
  };
  if (withResponse) window.Response = Response;
  window.window = window;
  vm.createContext(window);
  vm.runInContext(fs.readFileSync(BRIDGE_FETCH, 'utf8'), window, { filename: 'bridge-fetch.js' });
  return window;
}
