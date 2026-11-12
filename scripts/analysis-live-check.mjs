#!/usr/bin/env node
// Live check of Claude analysis (tool.analyze) against the real Anthropic API — NOT run in CI and
// never by the test suite. It runs the real processor `runJob` (the code the worker runs) on one
// image and one PDF and writes the reports into a fresh temp folder.
//
//   ANTHROPIC_API_KEY=… node scripts/analysis-live-check.mjs [files…] [--lang ko|en] [--instruction "…"]
//
//   files         images and/or PDFs to analyse (default: tests/fixtures/static/jpeg-source.jpg and
//                 tests/fixtures/static/korean-text.pdf)
//   --lang        report language (default ko)
//   --instruction the optional standing request (default none)
//
// The key is read from ANTHROPIC_API_KEY and handed to runJob exactly as main hands it to the worker
// (ProcessorRunContext.credentials); it is never printed. Requests go to api.anthropic.com only (the
// client pins its base URL). Every request is billed to the key's account (a few cents per file).
// Prints, per file: the report path, latency, stop_reason, the model that answered and token usage.
// Started with plain `node`, it re-runs itself with `--import tsx` (a root devDependency).
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CHILD_FLAG = 'ORBITDROP_ANALYSIS_LIVE_CHILD';
const argv = process.argv.slice(2);

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (value === undefined) {
    console.error(`analysis-live-check: ${name} needs a value`);
    process.exit(2);
  }
  argv.splice(index, 2);
  return value;
}

async function load(relative) {
  return import(pathToFileURL(join(root, relative)).href);
}

async function loadModules() {
  try {
    return { contracts: await load('packages/contracts/src/index.ts'), core: await load('packages/core/src/index.ts'), processors: await load('packages/processors/src/index.ts') };
  } catch (error) {
    if (process.env[CHILD_FLAG] === '1') throw error;
    // TypeScript sources (extensionless imports) need tsx: run again under it.
    const require = createRequire(join(root, 'package.json'));
    let tsx;
    try {
      tsx = pathToFileURL(require.resolve('tsx')).href;
    } catch {
      console.error('analysis-live-check: tsx is not installed (root devDependency; run pnpm install).');
      process.exit(2);
    }
    const result = spawnSync(process.execPath, ['--import', tsx, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: root,
      env: { ...process.env, [CHILD_FLAG]: '1' },
    });
    process.exit(result.status ?? 1);
  }
}

/**
 * Watch the streamed answers without touching them: the response body is teed and its SSE events read
 * for the stop reason, the model and the token counts. Request headers (the key) are never looked at.
 */
function observeResponses(observations) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const response = await realFetch(input, init);
    const observation = { host: url.host, path: url.pathname, status: response.status, requestId: response.headers.get('request-id'), model: null, stopReason: null, usage: null };
    observations.push(observation);
    if (!response.body || !(response.headers.get('content-type') ?? '').includes('text/event-stream')) return response;
    const [forSdk, forUs] = response.body.tee();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of forUs) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (!data) continue;
            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            if (event.type === 'message_start') {
              observation.model = event.message?.model ?? null;
              observation.usage = { ...event.message?.usage };
            } else if (event.type === 'message_delta') {
              observation.stopReason = event.delta?.stop_reason ?? null;
              observation.usage = { ...observation.usage, ...event.usage };
            }
          }
        }
      } catch {
        // the SDK side was cancelled
      }
    })();
    return new Response(forSdk, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function sniffedInput(contracts, core, path, index) {
  const handle = await open(path, 'r');
  let header;
  try {
    const buffer = new Uint8Array(core.SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const format = core.detectFormatFromHeader(header);
  if (format === null || contracts.inputKindOf(format) === undefined) throw new Error(`${basename(path)} is not an image or PDF OrbitDrop reads`);
  return { fileId: `live${index}`, path, displayName: basename(path), sourceDir: dirname(path), format, bytes: (await stat(path)).size };
}

const { contracts, core, processors } = await loadModules();
const language = option('--lang', 'ko');
const instruction = option('--instruction', '');
if (language !== 'ko' && language !== 'en') {
  console.error('analysis-live-check: --lang must be ko or en');
  process.exit(2);
}
const apiKey = contracts.normalizeAnalysisKey(process.env.ANTHROPIC_API_KEY ?? '');
if (!contracts.isPlausibleAnalysisKey(apiKey)) {
  console.error('analysis-live-check: set ANTHROPIC_API_KEY to an Anthropic API key (sk-ant-…). It is never printed.');
  process.exit(2);
}
const files = argv.length > 0 ? argv.map((path) => resolve(path)) : [join(root, 'tests/fixtures/static/jpeg-source.jpg'), join(root, 'tests/fixtures/static/korean-text.pdf')];
const outDir = await mkdtemp(join(tmpdir(), 'orbitdrop-analysis-live-'));
const observations = [];
observeResponses(observations);

console.log(`Claude analysis live check · ${contracts.ANALYSIS_MODEL.name} · report language ${language}${instruction ? ' · with a standing request' : ''}`);
console.log(`ANTHROPIC_API_KEY is set (not shown). Reports go to ${outDir}\n`);

let failures = 0;
for (const [index, path] of files.entries()) {
  const before = observations.length;
  const started = performance.now();
  try {
    const input = await sniffedInput(contracts, core, path, index);
    const job = {
      jobId: `live-${Date.now().toString(36)}-${index}`,
      actionId: 'tool.analyze',
      inputs: [input],
      options: { instruction, language },
      outputDir: outDir,
      settings: { pdfDpi: 300, jpegQuality: 90, webpQuality: 85, avifQuality: 60, heicQuality: 70 },
      limits: contracts.DEFAULT_PROCESSING_LIMITS,
    };
    const result = await processors.runJob(job, { signal: new AbortController().signal, onProgress: () => undefined, credentials: { anthropicApiKey: apiKey } });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    await new Promise((resolveLater) => setTimeout(resolveLater, 50)); // let the observer finish reading the stream
    const answer = observations.slice(before).filter((o) => o.path === '/v1/messages').at(-1);
    const output = result.outputs[0];
    console.log(`✓ ${input.displayName} (${input.format}, ${input.bytes} bytes)`);
    console.log(`  report     ${output.path} (${output.bytes} bytes)`);
    console.log(`  latency    ${seconds} s · ${observations.length - before} request(s) to ${[...new Set(observations.slice(before).map((o) => o.host))].join(', ')}`);
    console.log(`  stop       ${answer?.stopReason ?? '?'} · model ${answer?.model ?? '?'} · request ${answer?.requestId ?? '?'}`);
    console.log(`  tokens     input ${answer?.usage?.input_tokens ?? '?'} · output ${answer?.usage?.output_tokens ?? '?'}`);
    if (result.warnings.length > 0) console.log(`  warnings   ${result.warnings.map((w) => w.code).join(', ')}`);
    const preview = (await readFile(output.path, 'utf8')).split('\n').slice(0, 8).join('\n    ');
    console.log(`  begins     ${preview}\n`);
  } catch (error) {
    failures += 1;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const info = contracts.toErrorInfo(error);
    const statuses = observations.slice(before).map((o) => o.status);
    console.log(`✗ ${basename(path)} after ${seconds} s: ${info.code} — ${info.message}${info.detail ? ` (${info.detail})` : ''}${statuses.length ? ` · HTTP ${statuses.join(', ')}` : ''}\n`);
  }
}
console.log(failures === 0 ? `All ${files.length} file(s) analysed.` : `${failures} of ${files.length} file(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
