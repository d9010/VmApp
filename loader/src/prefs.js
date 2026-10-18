'use strict';
// The loader's own preferences: a few switches about how the LOADER behaves, kept in `<data root>/loader-prefs.json`. They are
// not permissions and are not per app. They are changed only in loader-owned UI (the Host Capabilities window); nothing an
// app sends can read or write them (INV-B5).
//
//   overlayShowTyped  false (default)  the virtual-input overlay masks typed text: "typing… (12 characters)". true: it shows the
//                                      first 28 characters (SPEC 8.2). Key combinations like ⌘S are always shown.
//   experimentalGpuVulkan  false (default)  "Experimental GPU (Vulkan)" (SPEC 8.7): an app that asks for the Vulkan GPU AND that the
//                                      user allowed it runs on the experimental libkrun backend only while this is on; off, it
//                                      runs on the normal backend without a GPU.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULTS = Object.freeze({ overlayShowTyped: false, experimentalGpuVulkan: false });

class LoaderPrefs extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.home the loader's data root
   * @param {(level,msg)=>void} [o.log]
   */
  constructor(o) {
    super();
    this.file = path.join(o.home, 'loader-prefs.json');
    this.log = o.log || (() => {});
    this.values = Object.assign({}, DEFAULTS);
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.log('warn', `${this.file}: ${e.message}; using the defaults`);
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const k of Object.keys(DEFAULTS)) if (typeof raw[k] === typeof DEFAULTS[k]) this.values[k] = raw[k];
  }

  /** The value of one preference (the default when it was never set). Throws for a name that is not a preference. */
  get(name) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) throw new Error(`unknown preference "${String(name).slice(0, 40)}"`);
    return this.values[name];
  }

  all() {
    return Object.assign({}, this.values);
  }

  /** Sets one preference and saves the file. Only known names and values of the right type are accepted. */
  set(name, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) throw new Error(`unknown preference "${String(name).slice(0, 40)}"`);
    if (typeof value !== typeof DEFAULTS[name]) throw new Error(`the preference "${name}" must be a ${typeof DEFAULTS[name]}`);
    if (this.values[name] === value) return this.all();
    const next = Object.assign({}, this.values, { [name]: value });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.values = next;
    this.emit('changed', this.all());
    return this.all();
  }
}

module.exports = { LoaderPrefs, DEFAULTS };
