/**
 * Must be the first import of the renderer entry. zod (pulled in by
 * @orbitdrop/contracts) probes `new Function("")` while schemas are created to
 * decide whether it may JIT-compile parsers. Our CSP forbids eval, so the probe
 * would only produce CSP violation reports. Setting zod's global config before
 * zod loads turns the probe off; parsing still works without JIT.
 */
const holder = globalThis as { __zod_globalConfig?: Record<string, unknown> };
holder.__zod_globalConfig = { ...holder.__zod_globalConfig, jitless: true };

export {};
