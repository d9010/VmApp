'use strict';
const path = require('path');

function resolveConfig(isPackaged) {
  return {
    isPackaged,
    preloadLoader: path.resolve(__dirname, '..', 'preload-loader.js'),
    preloadApp: path.resolve(__dirname, '..', 'preload-app.js'),
  };
}

module.exports = { resolveConfig };
