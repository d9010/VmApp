// Writes the list of third-party packages in the built UI from package-lock.json: every package that is not development-only (the
// bundle can contain only those), with the licence the lockfile records. Usage: node licenses.mjs <package-lock.json> <out.txt>
import fs from 'node:fs';

const [lockFile, outFile] = process.argv.slice(2);
if (!lockFile || !outFile) {
  console.error('usage: node licenses.mjs <package-lock.json> <out.txt>');
  process.exit(2);
}
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
const rows = [];
for (const [key, p] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/') || p.dev || p.link) continue;
  const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  rows.push({ name, version: p.version || '?', license: typeof p.license === 'string' ? p.license : JSON.stringify(p.license || 'see the package'), resolved: p.resolved || '' });
}
rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const counts = {};
for (const r of rows) counts[r.license] = (counts[r.license] || 0) + 1;
const lines = [
  'Third-party software in the window of Ollama (Desktop)',
  '',
  'The window is the React app of Ollama (https://github.com/ollama/ollama, app/ui/app, MIT licence, see LICENSE.ollama), built with the',
  'npm packages below: all packages of its package-lock.json that are not development-only. Each is under the licence named here;',
  "the licence texts are in each package's own distribution (npm). Licences in this list: " +
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([l, n]) => `${l} (${n})`)
      .join(', ') + '.',
  '',
  ...rows.map((r) => `${r.name}@${r.version}\t${r.license}\t${r.resolved}`),
  '',
];
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`licenses: ${rows.length} packages -> ${outFile}`);
