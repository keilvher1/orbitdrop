#!/usr/bin/env node
// Test-only stand-in for the native drag helper (macOS/Windows), speaking the
// NDJSON stdio protocol of packages/contracts/src/helper-protocol.ts. It has no
// UI and observes nothing: it reports `ready`, answers ping/queryPermissions,
// logs every message it receives to STUB_LOG and, after the first `configure`,
// replays the drops listed in STUB_DROPS (JSON array) — each one twice, to check
// that main accepts a drop only once per session. Exits on `shutdown` or stdin EOF.
import { appendFileSync } from 'node:fs';

const log = process.env.STUB_LOG;
const drops = process.env.STUB_DROPS ? JSON.parse(process.env.STUB_DROPS) : [];

if (process.argv[2] === 'imageio') {
  // ImageIO codec mode (ORBITDROP_IMAGEIO_HELPER): report no extra codecs.
  if (process.argv[3] === '--probe') process.stdout.write(`${JSON.stringify({ decode: [], encode: [] })}\n`);
  process.exit(process.argv[3] === '--probe' ? 0 : 2);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ v: 1, ...message })}\n`);
const record = (message) => {
  if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
};

send({
  type: 'ready',
  helperVersion: 'stub-1',
  platform: process.platform === 'win32' ? 'win32' : 'darwin',
  arch: process.arch === 'x64' ? 'x64' : 'arm64',
  osVersion: 'stub',
  pid: process.pid,
  globalDrag: { available: true },
});

let configured = false;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    record(message);
    switch (message.type) {
      case 'ping':
        send({ type: 'pong', nonce: message.nonce });
        break;
      case 'queryPermissions':
        send({ type: 'permissions', items: [] });
        break;
      case 'configure':
        if (!configured) {
          configured = true;
          setTimeout(() => {
            for (const drop of drops) {
              send({ type: 'state', sessionId: drop.sessionId, state: 'WheelActive', mode: drop.mode, fileCount: drop.files.length });
              const message = { type: 'drop', sessionId: drop.sessionId, actionId: drop.actionId, mode: drop.mode, files: drop.files, dropEffect: 'copy' };
              send(message);
              send(message); // duplicate: must be ignored by main
            }
          }, 100);
        }
        break;
      case 'shutdown':
        process.exit(0);
        break;
      default:
        break;
    }
  }
});
process.stdin.on('end', () => process.exit(0));
