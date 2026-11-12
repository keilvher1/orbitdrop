/**
 * The release scripts (scripts/package.mjs helpers, scripts/release-mac.mjs, scripts/release-assets.mjs)
 * with a fake command runner: no codesign, notarytool, stapler, spctl, git or gh is ever run here.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSigningIdentity, notaryCredentials, signAndNotarizeDmg } from '../../scripts/mac-dmg.mjs';
import { collectAssets, checkAssets, publishDraftAssets } from '../../scripts/release-assets.mjs';
import {
  CODE_SIGNING_POLICY_URL,
  ROOT,
  SUMS_FILE,
  checkUpdateInfo,
  ensureDraftRelease,
  formatSums,
  mergeUpdateInfo,
  parseReleaseTag,
  parseSums,
  refreshSha256Sums,
  refreshUpdateInfo,
  releaseNotes,
  sha256File,
  sha512File,
  yaml,
  type GitHubRelease,
  type RunOptions,
  type RunResult,
  type Runner,
  type UpdateInfo,
} from '../../scripts/release-lib.mjs';
import { macReleaseFiles, preflight, uploadMacRelease, verifyMacRelease } from '../../scripts/release-mac.mjs';

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly display?: readonly string[];
}
type Handler = (args: readonly string[], options: RunOptions) => Partial<RunResult> | undefined;

/** Answers by "<cmd> <first arg>" (or "<cmd>"); anything unanswered succeeds with no output. */
function fakeRunner(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const run: Runner = (cmd, args = [], options = {}) => {
    calls.push({ cmd, args: [...args], display: options.display });
    const handler = handlers[`${cmd} ${args[0] ?? ''}`.trim()] ?? handlers[cmd];
    const answer = handler?.(args, options);
    return { status: 0, stdout: '', stderr: '', ...answer };
  };
  return { run, calls, commands: () => calls.map((c) => [c.cmd, ...c.args].join(' ')) };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbitdrop-release-test-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const IDENTITY_LIST = [
  '  1) 1111111111111111111111111111111111111111 "Apple Development: Your Name (ABCDE12345)"',
  '  2) 2222222222222222222222222222222222222222 "Developer ID Application: Your Name (TEAMID1234)"',
  '  3) 3333333333333333333333333333333333333333 "Developer ID Installer: Your Name (TEAMID1234)"',
  '     3 valid identities found',
].join('\n');

const API_KEY_ENV = { APPLE_API_KEY: '/keys/AuthKey_KEYID12345.p8', APPLE_API_KEY_ID: 'KEYID12345', APPLE_API_ISSUER: '00000000-1111-2222-3333-444444444444' };

/** Writes a fake release file and returns its update-metadata entry. */
async function releaseFile(dir: string, name: string, content = `${name} bytes`): Promise<{ url: string; sha512: string; size: number }> {
  writeFileSync(join(dir, name), content);
  return { url: name, sha512: await sha512File(join(dir, name)), size: Buffer.byteLength(content) };
}

describe('tags and sums', () => {
  it('parses release tags', () => {
    expect(parseReleaseTag('v0.2.0')).toEqual({ tag: 'v0.2.0', version: '0.2.0', prerelease: false });
    expect(parseReleaseTag('v1.0.0-beta.2')).toEqual({ tag: 'v1.0.0-beta.2', version: '1.0.0-beta.2', prerelease: true });
    for (const bad of ['0.2.0', 'v0.2', 'release-0.2.0', 'v0.2.0/../x', undefined]) expect(() => parseReleaseTag(bad), String(bad)).toThrow(/not a release tag/);
  });

  it('writes SHA256SUMS.txt sorted, in the format shasum -c reads', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const text = formatSums([
      { name: 'latest.yml', sha256: b },
      { name: 'OrbitDrop-0.2.0-mac-arm64.dmg', sha256: a },
    ]);
    expect(text).toBe(`${a}  OrbitDrop-0.2.0-mac-arm64.dmg\n${b}  latest.yml\n`);
    expect([...parseSums(text)]).toEqual([
      ['OrbitDrop-0.2.0-mac-arm64.dmg', a],
      ['latest.yml', b],
    ]);
  });
});

describe('update metadata', () => {
  it('merges the per-arch latest-mac.yml files into one (x64 first, like electron-builder)', () => {
    const arm: UpdateInfo = { version: '0.2.0', files: [{ url: 'OrbitDrop-0.2.0-mac-arm64.zip', sha512: 'A', size: 1 }], path: 'OrbitDrop-0.2.0-mac-arm64.zip', sha512: 'A', releaseDate: '2026-11-12T10:00:00.000Z' };
    const x64: UpdateInfo = { version: '0.2.0', files: [{ url: 'OrbitDrop-0.2.0-mac-x64.zip', sha512: 'X', size: 2 }], path: 'OrbitDrop-0.2.0-mac-x64.zip', sha512: 'X', releaseDate: '2026-11-12T10:05:00.000Z' };
    const merged = mergeUpdateInfo([arm, x64]);
    expect(merged).toEqual({
      version: '0.2.0',
      files: [x64.files[0], arm.files[0]],
      path: 'OrbitDrop-0.2.0-mac-x64.zip',
      sha512: 'X',
      releaseDate: '2026-11-12T10:05:00.000Z',
    });
    expect(mergeUpdateInfo([arm])?.files).toHaveLength(1);
    expect(mergeUpdateInfo([])).toBeNull();
    expect(() => mergeUpdateInfo([arm, { ...x64, version: '0.3.0' }])).toThrow(/different versions/);
  });

  it('macOS: both zips, present, with the listed sha512 and size; never a DMG', async () => {
    const dir = tempDir();
    const arm = await releaseFile(dir, 'OrbitDrop-0.2.0-mac-arm64.zip');
    const x64 = await releaseFile(dir, 'OrbitDrop-0.2.0-mac-x64.zip');
    const options = { platform: 'darwin' as const, version: '0.2.0', archs: ['arm64', 'x64'] };
    const good = { version: '0.2.0', files: [x64, arm], path: x64.url, sha512: x64.sha512 };
    expect(await checkUpdateInfo(good, dir, options)).toEqual([]);

    expect(await checkUpdateInfo({ ...good, files: [arm] }, dir, options)).toContain('expected exactly one x64 zip, found 0');
    expect(await checkUpdateInfo({ ...good, version: '0.1.9' }, dir, options)).toContain('version is 0.1.9, expected 0.2.0');
    writeFileSync(join(dir, arm.url), 'changed after the metadata was written');
    const changed = await checkUpdateInfo(good, dir, options);
    expect(changed.some((p) => p.includes('sha512 does not match'))).toBe(true);
    const dmg = await releaseFile(dir, 'OrbitDrop-0.2.0-mac-arm64.dmg');
    expect(await checkUpdateInfo({ ...good, files: [x64, dmg] }, dir, options)).toEqual(expect.arrayContaining([expect.stringMatching(/must be zip files/)]));
    expect(await checkUpdateInfo({ ...good, files: [{ ...x64, url: '../x64.zip' }] }, dir, options)).toEqual(expect.arrayContaining([expect.stringMatching(/not a plain file name/)]));
    expect(await checkUpdateInfo({ ...good, files: [{ ...x64, url: 'OrbitDrop-0.2.0-mac-gone.zip' }] }, dir, options)).toEqual(expect.arrayContaining([expect.stringMatching(/listed but missing/)]));
  });

  it('Windows: exactly the -setup.exe the release has (the -unsigned label included)', async () => {
    const dir = tempDir();
    const setup = await releaseFile(dir, 'OrbitDrop-0.2.0-win-x64-unsigned-setup.exe');
    const options = { platform: 'win32' as const, version: '0.2.0' };
    expect(await checkUpdateInfo({ version: '0.2.0', files: [setup], path: setup.url, sha512: setup.sha512 }, dir, options)).toEqual([]);
    expect(await checkUpdateInfo({ version: '0.2.0', files: [{ ...setup, url: 'OrbitDrop-0.2.0-win-x64-setup.exe' }] }, dir, options)).toEqual(expect.arrayContaining([expect.stringMatching(/listed but missing/)]));
    expect(await checkUpdateInfo({ version: '0.2.0', files: [{ ...setup, size: 1 }] }, dir, options)).toEqual(expect.arrayContaining([expect.stringMatching(/size/)]));
  });

  it('Windows: after SignPath signed the installer, latest.yml gets its new sha512 and size, nothing else', async () => {
    const dir = tempDir();
    const setup = await releaseFile(dir, 'OrbitDrop-1.0.1-win-x64-setup.exe');
    const written = { version: '1.0.1', files: [setup], path: setup.url, sha512: setup.sha512, releaseDate: '2026-11-20T10:00:00.000Z' };
    const signedBytes = 'the same installer with an Authenticode signature appended';
    writeFileSync(join(dir, setup.url), signedBytes);
    const options = { platform: 'win32' as const, version: '1.0.1' };
    expect(await checkUpdateInfo(written, dir, options)).toEqual(expect.arrayContaining([expect.stringMatching(/sha512 does not match/)]));
    const refreshed = await refreshUpdateInfo(written, dir);
    expect(await checkUpdateInfo(refreshed, dir, options)).toEqual([]);
    expect(refreshed).toEqual({ ...written, files: [{ url: setup.url, sha512: await sha512File(join(dir, setup.url)), size: Buffer.byteLength(signedBytes) }], sha512: await sha512File(join(dir, setup.url)) });
    // An installer with a blockmap would need the blockmap rebuilt as well: refused.
    await expect(refreshUpdateInfo({ ...written, files: [{ ...setup, blockMapSize: 10 }] }, dir)).rejects.toThrow(/blockmap/);
    await expect(refreshUpdateInfo({ ...written, path: 'other.exe' }, dir)).rejects.toThrow(/legacy path/);
  });
});

describe('DMG signing and notarization', () => {
  it('reads notarization credentials like electron-builder and never shows their values', () => {
    const api = notaryCredentials(API_KEY_ENV)!;
    expect(api.kind).toBe('App Store Connect API key');
    expect(api.args).toEqual(['--key', API_KEY_ENV.APPLE_API_KEY, '--key-id', API_KEY_ENV.APPLE_API_KEY_ID, '--issuer', API_KEY_ENV.APPLE_API_ISSUER]);
    expect(api.display.join(' ')).not.toMatch(/KEYID12345|0000-1111|AuthKey/);
    expect(notaryCredentials({ APPLE_ID: 'me@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAMID1234' })?.display).toEqual(['--apple-id', '***', '--password', '***', '--team-id', '***']);
    expect(notaryCredentials({ APPLE_KEYCHAIN_PROFILE: 'orbitdrop' })?.args).toEqual(['--keychain-profile', 'orbitdrop']);
    expect(notaryCredentials({ APPLE_API_KEY_ID: 'only part' })).toBeNull();
  });

  it('finds the Developer ID Application identity named by CSC_NAME (with or without the prefix)', () => {
    const { run } = fakeRunner({ 'security find-identity': () => ({ stdout: IDENTITY_LIST }) });
    const expected = { hash: '2222222222222222222222222222222222222222', name: 'Developer ID Application: Your Name (TEAMID1234)', team: 'TEAMID1234' };
    expect(findSigningIdentity({ name: 'Your Name (TEAMID1234)', run })).toEqual(expected);
    expect(findSigningIdentity({ name: 'Developer ID Application: Your Name (TEAMID1234)', run })).toEqual(expected);
    expect(() => findSigningIdentity({ name: 'Someone Else (OTHER12345)', run })).toThrow(/no valid "Developer ID Application: …" identity/);
    expect(() => findSigningIdentity({ name: '', run })).toThrow(/CSC_NAME/);
  });

  function notaryRunner(options: { status?: string; timestamp?: boolean; spctl?: string; validate?: number } = {}) {
    return fakeRunner({
      'codesign -dvvv': () => ({ stderr: `Executable=/x.dmg\nAuthority=Developer ID Application: Your Name (TEAMID1234)\n${options.timestamp === false ? '' : 'Timestamp=12 Nov 2026 at 10:00:00\n'}` }),
      'xcrun notarytool': (args) =>
        args[1] === 'submit'
          ? { stdout: JSON.stringify({ id: 'f1e2d3c4-0000-4000-8000-000000000000', status: options.status ?? 'Accepted', message: 'Processing complete' }), status: options.status && options.status !== 'Accepted' ? 1 : 0 }
          : { stdout: JSON.stringify({ issues: [{ path: 'OrbitDrop.dmg/OrbitDrop.app/Contents/MacOS/OrbitDrop', message: 'The signature does not include a secure timestamp.' }] }) },
      'xcrun stapler': (args) => (args[1] === 'validate' ? { status: options.validate ?? 0, stdout: 'The validate action worked!' } : { stdout: 'The staple and validate action worked!' }),
      spctl: () => (options.spctl ? { status: 3, stderr: options.spctl } : { stderr: '/x.dmg: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Your Name (TEAMID1234)\n' }),
    });
  }

  const identity = { hash: '2222222222222222222222222222222222222222', name: 'Developer ID Application: Your Name (TEAMID1234)', team: 'TEAMID1234' };

  it('signs with a timestamp, notarizes, staples and verifies — in that order, secrets masked', () => {
    const fake = notaryRunner();
    const credentials = notaryCredentials(API_KEY_ENV)!;
    const report = signAndNotarizeDmg({ dmg: '/release/OrbitDrop-0.2.0-mac-arm64.dmg', identity, credentials, run: fake.run });
    expect(report).toMatchObject({
      file: 'OrbitDrop-0.2.0-mac-arm64.dmg',
      ok: true,
      timestamp: true,
      notarization: { id: 'f1e2d3c4-0000-4000-8000-000000000000', status: 'Accepted' },
      stapled: true,
      spctl: 'accepted: Notarized Developer ID',
      staplerValidate: 'ok',
      failedAt: null,
    });
    const dmg = '/release/OrbitDrop-0.2.0-mac-arm64.dmg';
    expect(fake.commands()).toEqual([
      `codesign --force --timestamp --sign ${identity.hash} ${dmg}`,
      `codesign -dvvv ${dmg}`,
      `xcrun notarytool submit ${dmg} ${credentials.args.join(' ')} --wait --output-format json`,
      `xcrun stapler staple ${dmg}`,
      `xcrun stapler validate ${dmg}`,
      `spctl -a -t open --context context:primary-signature -v ${dmg}`,
    ]);
    const submit = fake.calls.find((c) => c.args[1] === 'submit')!;
    expect(submit.display?.join(' ')).not.toMatch(/KEYID12345|0000-1111|AuthKey/);
  });

  it('a rejected submission reports Apple\'s issues and stops before stapling', () => {
    const fake = notaryRunner({ status: 'Invalid' });
    const attempt = (): (Error & { report?: unknown }) | null => {
      try {
        signAndNotarizeDmg({ dmg: '/r/a.dmg', identity, credentials: notaryCredentials(API_KEY_ENV)!, run: fake.run });
        return null;
      } catch (err) {
        return err as Error & { report?: unknown };
      }
    };
    const caught = attempt();
    expect(caught?.message).toMatch(/notarize failed: notary service status Invalid.*secure timestamp/);
    expect(caught?.report).toMatchObject({ failedAt: 'notarize', notarization: { status: 'Invalid' } });
    expect(fake.commands().some((c) => c.startsWith('xcrun notarytool log f1e2d3c4'))).toBe(true);
    expect(fake.commands().some((c) => c.startsWith('xcrun stapler'))).toBe(false);
  });

  it('a signature without a secure timestamp, a missing ticket or a rejection by spctl fail the DMG', () => {
    const credentials = notaryCredentials(API_KEY_ENV)!;
    expect(() => signAndNotarizeDmg({ dmg: '/r/a.dmg', identity, credentials, run: notaryRunner({ timestamp: false }).run })).toThrow(/sign failed: .*no secure timestamp/);
    expect(() => signAndNotarizeDmg({ dmg: '/r/a.dmg', identity, credentials, run: notaryRunner({ validate: 65 }).run })).toThrow(/verify failed: stapler validate/);
    expect(() => signAndNotarizeDmg({ dmg: '/r/a.dmg', identity, credentials, run: notaryRunner({ spctl: '/r/a.dmg: rejected\nsource=no usable signature\n' }).run })).toThrow(/verify failed: spctl: rejected: no usable signature/);
  });
});

/** gh as GitHub answers it, with one mutable release list. */
function githubRunner(releases: GitHubRelease[], extra: Record<string, Handler> = {}) {
  return fakeRunner({
    'gh api': () => ({ stdout: JSON.stringify(releases) }),
    'gh release': (args, options) => {
      if (args[1] === 'create') releases.push({ tag_name: args[2]!, draft: args.includes('--draft'), assets: [], html_url: `https://github.com/keilvher1/orbitdrop/releases/tag/${args[2]}` });
      return extra[`gh release ${args[1]}`]?.(args, options);
    },
    ...extra,
  });
}

describe('draft releases', () => {
  it('waits for a just-created draft to show up in the release list (GitHub lists it a few seconds later)', () => {
    const releases: GitHubRelease[] = [];
    let created: GitHubRelease | null = null;
    let listsAfterCreate = 0;
    const fake = fakeRunner({
      // The list lags: the first two looks after the create still miss the new draft (seen on v1.0.0).
      'gh api': () => {
        if (created) listsAfterCreate += 1;
        if (created && listsAfterCreate > 2 && !releases.includes(created)) releases.push(created);
        return { stdout: JSON.stringify(releases) };
      },
      'gh release': (args) => {
        // A draft's URL is not under its tag until it is published.
        if (args[1] === 'create') created = { tag_name: args[2]!, draft: true, assets: [], html_url: 'https://github.com/keilvher1/orbitdrop/releases/tag/untagged-754651ed24b8c5c44ad2' };
        return { stdout: 'https://github.com/keilvher1/orbitdrop/releases/tag/untagged-754651ed24b8c5c44ad2' };
      },
    });
    const draft = ensureDraftRelease({ tag: 'v1.0.0', title: 'OrbitDrop 1.0.0', notes: 'n', run: fake.run, workDir: tempDir(), findDelayMs: 0 });
    expect(draft).toMatchObject({ tag_name: 'v1.0.0', draft: true });
    expect(fake.calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);
    expect(listsAfterCreate).toBe(3);

    // Never listed at all: a clear error after the retries, and still only one create.
    const never = fakeRunner({ 'gh api': () => ({ stdout: '[]' }), 'gh release': () => ({ stdout: 'https://github.com/keilvher1/orbitdrop/releases/tag/untagged-1' }) });
    expect(() => ensureDraftRelease({ tag: 'v1.0.1', title: 't', notes: 'n', run: never.run, workDir: tempDir(), findAttempts: 3, findDelayMs: 0 })).toThrow(/could not create the draft release for v1\.0\.1/);
    expect(never.calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);
  });

  it('the release notes link the code signing policy, a page the website really has', () => {
    const notes = releaseNotes('1.0.1');
    expect(notes).toContain(`Code signing policy (who signs what, and how): ${CODE_SIGNING_POLICY_URL}`);
    expect(notes).toContain('`-unsigned`'); // true whether or not this release's installer is signed
    const page = new URL(CODE_SIGNING_POLICY_URL);
    expect(page.origin + page.pathname.slice(0, '/orbitdrop/'.length)).toBe('https://keilvher1.github.io/orbitdrop/');
    const file = join(ROOT, 'site', ...page.pathname.slice('/orbitdrop/'.length).split('/').filter(Boolean), 'index.html');
    expect(readFileSync(file, 'utf8')).toContain('<h1>Code signing policy</h1>');
  });

  it('creates the draft when it is missing, reuses a draft, and never touches a published release', () => {
    const releases: GitHubRelease[] = [];
    const fake = githubRunner(releases);
    const workDir = tempDir();
    const draft = ensureDraftRelease({ tag: 'v0.2.0-beta.1', title: 'OrbitDrop 0.2.0-beta.1', notes: 'notes', prerelease: true, run: fake.run, workDir });
    expect(draft).toMatchObject({ tag_name: 'v0.2.0-beta.1', draft: true });
    const create = fake.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toEqual(expect.arrayContaining(['--draft', '--verify-tag', '--prerelease', '--repo', 'keilvher1/orbitdrop']));
    expect(create.args).not.toContain('--publish');
    expect(readFileSync(join(workDir, 'release-notes.md'), 'utf8')).toBe('notes');

    ensureDraftRelease({ tag: 'v0.2.0-beta.1', title: 't', notes: 'n', run: fake.run, workDir });
    expect(fake.calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);

    releases[0]!.draft = false;
    expect(() => ensureDraftRelease({ tag: 'v0.2.0-beta.1', title: 't', notes: 'n', run: fake.run, workDir })).toThrow(/already published/);

    // gh looks the tag up itself: with two releases for one tag it could write to the published one.
    releases.push({ tag_name: 'v0.2.0-beta.1', draft: true, assets: [] });
    expect(() => ensureDraftRelease({ tag: 'v0.2.0-beta.1', title: 't', notes: 'n', run: fake.run, workDir })).toThrow(/2 releases use the tag v0\.2\.0-beta\.1 \(published, draft\)/);
    releases[0]!.draft = true;
    expect(() => ensureDraftRelease({ tag: 'v0.2.0-beta.1', title: 't', notes: 'n', run: fake.run, workDir })).toThrow(/2 releases use the tag/);
    expect(fake.calls.some((c) => c.args[1] === 'upload')).toBe(false);
  });

  it('SHA256SUMS.txt covers every asset: GitHub digests, a download where none exists, uploads cross-checked', async () => {
    const workDir = tempDir();
    const local = tempDir();
    writeFileSync(join(local, 'OrbitDrop-0.2.0-mac-arm64.dmg'), 'dmg');
    const dmgHash = await sha256File(join(local, 'OrbitDrop-0.2.0-mac-arm64.dmg'));
    const exeHash = 'e'.repeat(64);
    const releases: GitHubRelease[] = [
      {
        tag_name: 'v0.2.0',
        draft: true,
        assets: [
          { name: 'OrbitDrop-0.2.0-mac-arm64.dmg', digest: `sha256:${dmgHash}` },
          { name: 'OrbitDrop-0.2.0-win-x64-unsigned-setup.exe', digest: `sha256:${exeHash}` },
          { name: 'latest.yml', digest: null },
          { name: SUMS_FILE, digest: `sha256:${'0'.repeat(64)}` },
        ],
      },
    ];
    const fake = githubRunner(releases, {
      'gh release download': (args) => {
        const dir = args[args.indexOf('--dir') + 1]!;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, args[args.indexOf('--pattern') + 1]!), 'version: 0.2.0\n');
        return {};
      },
    });
    const entries = await refreshSha256Sums({ tag: 'v0.2.0', run: fake.run, localHashes: new Map([['OrbitDrop-0.2.0-mac-arm64.dmg', dmgHash]]), workDir });
    expect(entries.map((e) => e.name).sort()).toEqual(['OrbitDrop-0.2.0-mac-arm64.dmg', 'OrbitDrop-0.2.0-win-x64-unsigned-setup.exe', 'latest.yml']);
    const sums = parseSums(readFileSync(join(workDir, SUMS_FILE), 'utf8'));
    expect(sums.get('OrbitDrop-0.2.0-win-x64-unsigned-setup.exe')).toBe(exeHash);
    expect(sums.get('latest.yml')).toMatch(/^[0-9a-f]{64}$/);
    expect(sums.has(SUMS_FILE)).toBe(false);

    await expect(refreshSha256Sums({ tag: 'v0.2.0', run: fake.run, localHashes: new Map([['OrbitDrop-0.2.0-mac-arm64.dmg', 'f'.repeat(64)]]), workDir })).rejects.toThrow(/do not match/);
    await expect(refreshSha256Sums({ tag: 'v0.2.0', run: fake.run, localHashes: new Map([['OrbitDrop-0.2.0-mac-x64.dmg', dmgHash]]), workDir })).rejects.toThrow(/uploaded but is not on the release/);
    releases[0]!.draft = false;
    await expect(refreshSha256Sums({ tag: 'v0.2.0', run: fake.run, workDir })).rejects.toThrow(/already published/);
  });
});

/** A release folder as package.mjs leaves it for `version` (both macOS archs). */
async function macReleaseFolder(version: string, commit: string, reportOverrides: Record<string, unknown> = {}): Promise<string> {
  const dir = tempDir();
  const zips = [];
  for (const arch of ['x64', 'arm64']) {
    await releaseFile(dir, `OrbitDrop-${version}-mac-${arch}.dmg`);
    zips.push(await releaseFile(dir, `OrbitDrop-${version}-mac-${arch}.zip`));
    await releaseFile(dir, `OrbitDrop-${version}-mac-${arch}.zip.blockmap`);
    const report = {
      version,
      source: { commit, dirty: false },
      signing: { mode: 'Developer ID', notarize: true },
      dmgNotarization: { ok: true },
      smoke: { ok: true },
      nativeCheck: { ran: true, ok: true },
      inspection: { buildInfo: { signing: 'developer-id' } },
      ...reportOverrides,
    };
    writeFileSync(join(dir, `build-report-darwin-${arch}.json`), JSON.stringify(report));
  }
  writeFileSync(join(dir, 'latest-mac.yml'), yaml().dump({ version, files: zips, path: zips[0]!.url, sha512: zips[0]!.sha512 }));
  return dir;
}

describe('scripts/release-mac.mjs', () => {
  const COMMIT = 'c0ffee'.padEnd(40, '0');

  function gitRunner(options: { status?: string; head?: string; tag?: string | null; remote?: string; auth?: number } = {}) {
    return fakeRunner({
      'git status': () => ({ stdout: options.status ?? '' }),
      'git rev-parse': (args) => (args[1] === 'HEAD' ? { stdout: `${options.head ?? COMMIT}\n` } : options.tag === null ? { status: 1 } : { stdout: `${options.tag ?? COMMIT}\n` }),
      'git ls-remote': () => ({ stdout: options.remote ?? `abcdef1234567890abcdef1234567890abcdef12\trefs/tags/v0.2.0\n${COMMIT}\trefs/tags/v0.2.0^{}\n` }),
      'gh auth': () => ({ status: options.auth ?? 0 }),
    });
  }

  function repo(version = '0.2.0'): string {
    const root = tempDir();
    mkdirSync(join(root, 'apps', 'desktop'), { recursive: true });
    writeFileSync(join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ version }));
    return root;
  }

  const env = { CSC_NAME: 'Your Name (TEAMID1234)', ...API_KEY_ENV };
  const fileExists = () => true;

  it('passes on a clean checkout of the pushed tag with signing and notarization settings', () => {
    expect(preflight({ tag: 'v0.2.0', env, run: gitRunner().run, root: repo(), platform: 'darwin', fileExists })).toEqual({ tag: 'v0.2.0', version: '0.2.0', prerelease: false, commit: COMMIT });
  });

  it('refuses a dirty tree, another commit, a version mismatch, an unpushed tag and missing settings — all at once', () => {
    const attempt = (options: Parameters<typeof gitRunner>[0], overrides: { env?: Record<string, string | undefined>; version?: string; platform?: NodeJS.Platform; exists?: boolean } = {}) => {
      try {
        preflight({ tag: 'v0.2.0', env: overrides.env ?? env, run: gitRunner(options).run, root: repo(overrides.version), platform: overrides.platform ?? 'darwin', fileExists: () => overrides.exists ?? true });
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(attempt({ status: ' M apps/desktop/src/main/app.ts\n?? notes.txt' })).toMatch(/working tree has changes/);
    expect(attempt({ head: 'd'.repeat(40) })).toMatch(/HEAD \(dddddddddddd\) is not v0\.2\.0/);
    expect(attempt({ tag: null })).toMatch(/there is no tag v0\.2\.0/);
    expect(attempt({ remote: '' })).toMatch(/not on GitHub yet: git push origin v0\.2\.0/);
    expect(attempt({}, { version: '0.1.9' })).toMatch(/says version 0\.1\.9, the tag says 0\.2\.0/);
    expect(attempt({}, { env: { ...API_KEY_ENV } })).toMatch(/CSC_NAME is not set/);
    expect(attempt({}, { env: { ...env, CSC_LINK: 'cert.p12' } })).toMatch(/unset CSC_LINK/);
    expect(attempt({}, { env: { CSC_NAME: env.CSC_NAME } })).toMatch(/no notarization credentials/);
    expect(attempt({}, { exists: false })).toMatch(/APPLE_API_KEY does not name an existing \.p8 file/);
    expect(attempt({ auth: 1 })).toMatch(/gh is not logged in/);
    expect(attempt({}, { platform: 'win32' })).toMatch(/built on a Mac/);
    const all = attempt({ status: ' M x' }, { env: {}, version: '9.9.9' });
    expect(all.split('\n  - ').length).toBeGreaterThanOrEqual(4);
    // Placeholders only: the error texts never contain a credential value.
    expect(attempt({}, { env: { ...env, APPLE_API_KEY_ID: undefined } })).not.toMatch(/KEYID12345/);
  });

  it('verifies the packages: reports, latest-mac.yml, DMG spctl and stapler', async () => {
    const dir = await macReleaseFolder('0.2.0', COMMIT);
    const fine = fakeRunner({ spctl: () => ({ stderr: 'accepted\nsource=Notarized Developer ID\n' }) });
    expect(await verifyMacRelease({ dir, version: '0.2.0', commit: COMMIT, run: fine.run, appChecks: false })).toEqual([]);
    expect(fine.commands().filter((c) => c.startsWith('spctl -a -t open'))).toHaveLength(2);

    const unsigned = await macReleaseFolder('0.2.0', COMMIT, { signing: { mode: 'unsigned (ad-hoc signature)', notarize: false }, dmgNotarization: { ok: false } });
    const problems = await verifyMacRelease({ dir: unsigned, version: '0.2.0', commit: COMMIT, run: fine.run, appChecks: false });
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/not Developer ID/), expect.stringMatching(/not notarized/), expect.stringMatching(/DMG was not signed/)]));

    const rejected = fakeRunner({ spctl: () => ({ status: 3, stderr: 'rejected\nsource=no usable signature\n' }) });
    expect(await verifyMacRelease({ dir, version: '0.2.0', commit: COMMIT, run: rejected.run, appChecks: false })).toEqual(expect.arrayContaining([expect.stringMatching(/DMG: spctl/)]));
    expect(await verifyMacRelease({ dir, version: '0.2.0', commit: 'e'.repeat(40), run: fine.run, appChecks: false })).toEqual(expect.arrayContaining([expect.stringMatching(/built from c0ffee000000/)]));
    rmSync(join(dir, 'latest-mac.yml'));
    expect(await verifyMacRelease({ dir, version: '0.2.0', commit: COMMIT, run: fine.run, appChecks: false })).toEqual(['latest-mac.yml is missing']);
  });

  it('uploads the macOS files to the draft, then SHA256SUMS.txt over all assets', async () => {
    const dir = await macReleaseFolder('0.2.0', COMMIT);
    const names = macReleaseFiles('0.2.0');
    const digests = new Map<string, string>();
    for (const name of names) digests.set(name, await sha256File(join(dir, name)));
    const releases: GitHubRelease[] = [{ tag_name: 'v0.2.0', draft: true, assets: [{ name: 'latest.yml', digest: `sha256:${'1'.repeat(64)}` }] }];
    const fake = githubRunner(releases, {
      'gh release upload': (args) => {
        for (const file of args.slice(3, args.indexOf('--repo'))) {
          const name = basename(file);
          const assets = releases[0]!.assets!;
          const digest = digests.get(name) ?? (existsSync(file) ? 'sums' : '');
          assets.splice(0, assets.length, ...assets.filter((a) => a.name !== name), { name, digest: digest === 'sums' ? null : `sha256:${digest}` });
        }
        return {};
      },
      'gh release download': (args) => {
        const target = join(args[args.indexOf('--dir') + 1]!);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, args[args.indexOf('--pattern') + 1]!), 'x');
        return {};
      },
    });
    const workDir = tempDir();
    const result = await uploadMacRelease({ tag: 'v0.2.0', version: '0.2.0', prerelease: false, dir, run: fake.run, workDir });
    expect(result.uploaded).toEqual(names);
    expect(result.sums).toBe(names.length + 1); // + latest.yml from the Windows build
    const uploads = fake.calls.filter((c) => c.args[1] === 'upload');
    expect(uploads[0]!.args).toEqual(expect.arrayContaining(['--clobber', '--repo', 'keilvher1/orbitdrop']));
    expect(uploads.at(-1)!.args.slice(2, 4)).toEqual(['v0.2.0', join(workDir, SUMS_FILE)]);
    expect(fake.calls.some((c) => c.args.includes('--draft=false') || c.args[1] === 'edit')).toBe(false); // never published
    const sums = parseSums(readFileSync(join(workDir, SUMS_FILE), 'utf8'));
    expect(sums.get('OrbitDrop-0.2.0-mac-arm64.dmg')).toBe(digests.get('OrbitDrop-0.2.0-mac-arm64.dmg'));
    expect(sums.get('latest.yml')).toBe('1'.repeat(64));
  });
});

describe('scripts/release-assets.mjs (CI)', () => {
  it('collects one folder per workflow artifact and refuses unsigned macOS packages', async () => {
    const root = tempDir();
    const mac = await macReleaseFolder('0.2.0', 'c'.repeat(40), { signing: { mode: 'unsigned (ad-hoc signature)', notarize: false } });
    const win = join(root, 'OrbitDrop-windows-12');
    mkdirSync(win);
    const setup = await releaseFile(win, 'OrbitDrop-0.2.0-win-x64-unsigned-setup.exe');
    writeFileSync(join(win, 'latest.yml'), yaml().dump({ version: '0.2.0', files: [setup], path: setup.url, sha512: setup.sha512 }));
    writeFileSync(join(win, 'build-report-win32-x64.json'), JSON.stringify({ version: '0.2.0' }));
    const sources = join(root, 'OrbitDrop-third-party-sources-12');
    mkdirSync(sources);
    writeFileSync(join(sources, 'OrbitDrop-0.2.0-third-party-sources.tar.gz'), 'sources');

    const windowsOnly = collectAssets(root);
    expect([...windowsOnly.keys()].sort()).toEqual(['OrbitDrop-0.2.0-third-party-sources.tar.gz', 'OrbitDrop-0.2.0-win-x64-unsigned-setup.exe', 'build-report-win32-x64.json', 'latest.yml']);
    expect(await checkAssets(windowsOnly, '0.2.0')).toEqual([]);
    const noSources = new Map([...windowsOnly].filter(([name]) => !name.endsWith('-third-party-sources.tar.gz')));
    expect(await checkAssets(noSources, '0.2.0')).toEqual([expect.stringMatching(/third-party-sources\.tar\.gz \(LGPL\/MPL corresponding sources\) is missing/)]);
    expect(await checkAssets(windowsOnly, '0.3.0')).toEqual(expect.arrayContaining([expect.stringMatching(/not a 0\.3\.0 package/)]));

    const withMac = new Map([...windowsOnly, ...collectAssets(mac)]);
    expect(await checkAssets(withMac, '0.2.0')).toEqual(expect.arrayContaining([expect.stringMatching(/macOS arm64: not signed with a Developer ID and notarized/)]));
    const noReports = new Map([...withMac].filter(([name]) => !name.startsWith('build-report-darwin')));
    expect(await checkAssets(noReports, '0.2.0')).toEqual(expect.arrayContaining([expect.stringMatching(/unsigned or unverified macOS packages are never uploaded/)]));
  });

  it('Windows: an installer named as signed needs a build report with verified signatures; rehearsals never go up', async () => {
    const folder = async (name: string, report: object) => {
      const root = tempDir();
      const setup = await releaseFile(root, name);
      writeFileSync(join(root, 'latest.yml'), yaml().dump({ version: '1.0.1', files: [setup], path: setup.url, sha512: setup.sha512 }));
      writeFileSync(join(root, 'build-report-win32-x64.json'), JSON.stringify({ version: '1.0.1', ...report }));
      writeFileSync(join(root, 'OrbitDrop-1.0.1-third-party-sources.tar.gz'), 'sources');
      return collectAssets(root);
    };
    const verified = { expected: 'signed', ok: true, files: [{ file: 'OrbitDrop.exe', signature: 'Valid' }] };
    // SignPath: signed, every own executable Valid (scripts/package.mjs --signpath finish).
    expect(await checkAssets(await folder('OrbitDrop-1.0.1-win-x64-setup.exe', { signing: { mode: 'Authenticode (SignPath)' }, signatures: verified }), '1.0.1')).toEqual([]);
    // Unsigned and labelled so: as before.
    expect(await checkAssets(await folder('OrbitDrop-1.0.1-win-x64-unsigned-setup.exe', { signing: { mode: 'unsigned' }, signatures: { expected: 'unsigned', ok: true } }), '1.0.1')).toEqual([]);
    // A signed-looking name without the evidence, or a label that contradicts the report.
    expect(await checkAssets(await folder('OrbitDrop-1.0.1-win-x64-setup.exe', { signing: { mode: 'unsigned' } }), '1.0.1')).toEqual([expect.stringMatching(/named as a signed installer, but .* no verified Authenticode signatures \("unsigned"\)/)]);
    expect(await checkAssets(await folder('OrbitDrop-1.0.1-win-x64-setup.exe', { signing: { mode: 'Authenticode (SignPath)' }, signatures: { ...verified, ok: false } }), '1.0.1')).toEqual([expect.stringMatching(/no verified Authenticode signatures/)]);
    expect(await checkAssets(await folder('OrbitDrop-1.0.1-win-x64-unsigned-setup.exe', { signing: { mode: 'Authenticode (SignPath)' }, signatures: verified }), '1.0.1')).toEqual([expect.stringMatching(/labelled unsigned, but its build report says "Authenticode \(SignPath\)"/)]);
    // The rehearsal of the SignPath flow (self-signed stand-in) is never released, whatever its report says.
    expect(await checkAssets(await folder('OrbitDrop-1.0.1-win-x64-rehearsal-setup.exe', { signing: { mode: 'Authenticode (SignPath rehearsal: self-signed stand-in, never released)' }, signatures: verified }), '1.0.1')).toEqual([expect.stringMatching(/rehearsal of the SignPath flow .* never goes to a release/)]);
  });

  it('uploads what CI built to the draft (created if needed) and the sums', async () => {
    const root = tempDir();
    const setup = await releaseFile(root, 'OrbitDrop-0.2.0-win-x64-unsigned-setup.exe');
    writeFileSync(join(root, 'latest.yml'), yaml().dump({ version: '0.2.0', files: [setup], path: setup.url, sha512: setup.sha512 }));
    writeFileSync(join(root, 'build-report-win32-x64.json'), JSON.stringify({ version: '0.2.0' }));
    writeFileSync(join(root, 'OrbitDrop-0.2.0-third-party-sources.tar.gz'), 'sources');
    const releases: GitHubRelease[] = [];
    const fake = githubRunner(releases, {
      'gh release upload': (args) => {
        const assets = releases[0]!.assets!;
        for (const file of args.slice(3, args.indexOf('--repo'))) assets.push({ name: basename(file), digest: null });
        return {};
      },
      'gh release download': (args) => {
        const target = args[args.indexOf('--dir') + 1]!;
        mkdirSync(target, { recursive: true });
        const name = args[args.indexOf('--pattern') + 1]!;
        writeFileSync(join(target, name), readFileSync(join(root, name)));
        return {};
      },
    });
    const result = await publishDraftAssets({ tag: 'v0.2.0', dir: root, run: fake.run, workDir: tempDir() });
    expect(result.uploaded).toEqual(['OrbitDrop-0.2.0-third-party-sources.tar.gz', 'OrbitDrop-0.2.0-win-x64-unsigned-setup.exe', 'build-report-win32-x64.json', 'latest.yml']);
    expect(releases[0]).toMatchObject({ tag_name: 'v0.2.0', draft: true });
    expect(result.sums).toBe(4);
  });
});
