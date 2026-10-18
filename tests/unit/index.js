'use strict';
// Entry point so that `node --test vmapp/tests/unit/` works on Node 22 (a directory argument is resolved like
// require(dir), i.e. to this file). Individual files also run on their own: node --test vmapp/tests/unit/*.test.js
const fs = require('fs');
const path = require('path');

for (const f of fs.readdirSync(__dirname).sort()) {
  if (f.endsWith('.test.js')) require(path.join(__dirname, f));
}
