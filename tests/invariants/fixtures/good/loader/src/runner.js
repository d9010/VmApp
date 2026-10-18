'use strict';
const { AppWindowManager, lockPartition } = require('./window-manager');

class Runner {
  constructor({ cfg, registry, handleAppUi }) {
    this.cfg = cfg;
    this.registry = registry;
    this.handleAppUi = handleAppUi;
  }

  start(app) {
    lockPartition(`persist:vmapp-${app.id}`, this.handleAppUi);
    return new AppWindowManager({
      app,
      registry: this.registry,
      preload: this.cfg.preloadApp,
    });
  }
}

module.exports = { Runner };
