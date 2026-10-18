'use strict';
// A tiny MCP server over stdio (newline-delimited JSON-RPC 2.0) for the tests.
//   FAKE_MCP_LOG=<file>  appended JSON lines: {event:'start',pid}, {event:'initialize',protocolVersion},
//                        {event:'initialized'}, {event:'request',method}
// Tools: echo (returns its arguments), pid, env (names of its environment variables), fail (JSON-RPC error),
// hang (never answers). tools/list is paged (2 pages) to exercise cursors. It exits when stdin closes.
const fs = require('fs');
const readline = require('readline');

const LOG = process.env.FAKE_MCP_LOG;
const log = (o) => LOG && fs.appendFileSync(LOG, JSON.stringify(o) + '\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

log({ event: 'start', pid: process.pid });

const TOOLS_1 = [
  { name: 'echo', description: 'Echoes its arguments', inputSchema: { type: 'object' } },
  { name: 'pid', description: 'The server pid', inputSchema: { type: 'object' } },
];
const TOOLS_2 = [{ name: 'env', description: 'Environment variable names', inputSchema: { type: 'object' } }];

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'notifications/initialized') return log({ event: 'initialized' });
  if (m.id === undefined) return;
  if (m.method !== 'initialize') log({ event: 'request', method: m.method });
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      log({ event: 'initialize', protocolVersion: m.params && m.params.protocolVersion });
      return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fake-mcp', version: '1.0' } });
    case 'ping':
      return ok({});
    case 'tools/list':
      return m.params && m.params.cursor === 'page2' ? ok({ tools: TOOLS_2 }) : ok({ tools: TOOLS_1, nextCursor: 'page2' });
    case 'tools/call': {
      const { name, arguments: args } = m.params || {};
      if (name === 'echo') return ok({ content: [{ type: 'text', text: JSON.stringify(args || {}) }] });
      if (name === 'pid') return ok({ content: [{ type: 'text', text: String(process.pid) }] });
      if (name === 'env') return ok({ content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] });
      if (name === 'hang') return undefined;
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: `tool ${name} failed` } });
    }
    case 'resources/list':
      return ok({ resources: [{ uri: 'file:///fake.txt', name: 'fake.txt' }] });
    case 'resources/read':
      return ok({ contents: [{ uri: m.params && m.params.uri, text: 'fake contents' }] });
    case 'prompts/list':
      return ok({ prompts: [{ name: 'hello' }] });
    case 'prompts/get':
      return ok({ messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] });
    default:
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
}).on('close', () => process.exit(0));
