// Native-module check for a packaged OrbitDrop build (run by scripts/package.mjs; never shipped).
// A stock Electron runtime of the same version starts this tiny app, which forks check.mjs in a
// utilityProcess — like OrbitDrop's processor workers — against the module files inside the
// packaged app's Resources folder (passed as the last argument). The packaged binary itself
// cannot run arbitrary scripts (RunAsNode fuse off, asar-only), so this is the closest check.
'use strict';
const { app, utilityProcess } = require('electron');
const path = require('node:path');

const resources = process.argv[process.argv.length - 1];
app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'check.mjs'), [resources], { stdio: 'pipe' });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('exit', (code) => {
    process.stdout.write(out);
    if (code !== 0) process.stdout.write(`NATIVE_CHECK_CHILD_EXIT ${code} ${JSON.stringify(err.slice(-1500))}\n`);
    app.exit(code === 0 ? 0 : 1);
  });
  setTimeout(() => {
    process.stdout.write('NATIVE_CHECK_TIMEOUT\n');
    app.exit(2);
  }, 90000).unref();
});
