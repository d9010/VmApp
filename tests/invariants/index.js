'use strict';
// Entry point so that `node --test vmapp/tests/invariants/` works on Node 22 (a directory argument is resolved like
// require(dir), i.e. to this file; it also keeps node from running the fixture sources as tests).
// Individual files also run on their own: node --test vmapp/tests/invariants/rules.test.js
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith('.test.js')) require(path.join(__dirname, f));
}
