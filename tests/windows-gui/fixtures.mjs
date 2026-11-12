#!/usr/bin/env node
// Source files for the Windows GUI drag test: the repository's own fixtures (scripts/gen-fixtures.mjs),
// a one-page PDF and a JPG. The driver copies them under one name per test case.
//
//   node tests/windows-gui/fixtures.mjs <dir>
import { resolve } from 'node:path';
import { generateFixtures } from '../../scripts/gen-fixtures.mjs';

const dir = resolve(process.argv[2] ?? 'gui-fixtures');
const paths = await generateFixtures(dir, { only: ['Page 001.pdf', 'photo.jpg'] });
console.log(JSON.stringify(paths, null, 2));
