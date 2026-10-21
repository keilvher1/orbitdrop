// electron-builder resolves hook paths against the working directory and refuses paths outside
// the detected workspace root (detection can fall back to apps/desktop, e.g. on Windows), so the
// config points here and the implementation lives in scripts/after-pack.cjs.
'use strict';
module.exports = require('../../../scripts/after-pack.cjs');
