'use strict';
/**
 * Production entry point for the local relay server (utilityProcess.fork target).
 * Applies the better-sqlite3 → Electron binary redirect before loading the relay bundle.
 * Location in packaged app: resources/relay/wrapper.js
 * The Electron-compiled .node binary lives at:  resources/.cache/better_sqlite3.electron.node
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');

const nativeBin = path.join(__dirname, '..', '.cache', 'better_sqlite3.electron.node');

if (fs.existsSync(nativeBin)) {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (typeof request === 'string' && request.includes('better_sqlite3') && request.endsWith('.node')) {
      return nativeBin;
    }
    return origResolve.call(this, request, ...args);
  };

  const origDlopen = process.dlopen;
  process.dlopen = function (mod, filename, ...args) {
    if (typeof filename === 'string' && filename.includes('better_sqlite3')) {
      return origDlopen.call(this, mod, nativeBin, ...args);
    }
    return origDlopen.call(this, mod, filename, ...args);
  };
} else {
  process.stderr.write('[relay-wrapper] WARNING: Electron binary not found at ' + nativeBin + '\n');
}

require(path.join(__dirname, 'bundle.js'));
