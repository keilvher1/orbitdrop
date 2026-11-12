// Developer ID signing, notarization and stapling of the macOS DMGs (scripts/package.mjs).
//
// electron-builder signs, notarizes and staples the app inside; the DMG around it stays unsigned
// (spctl: "rejected, source=no usable signature"). For a Developer ID build with notarization
// credentials, every DMG is then:
//   1. signed with the same Developer ID Application identity, with a secure timestamp;
//   2. submitted to Apple's notary service and waited for (xcrun notarytool submit --wait);
//   3. stapled (xcrun stapler staple) — this changes the DMG's bytes, so its SHA-256 is computed
//      afterwards, and latest-mac.yml never lists DMGs (updates use the zips);
//   4. verified: spctl -a -t open --context context:primary-signature (accepted, Notarized
//      Developer ID) and xcrun stapler validate.
//
// The identity must be in a keychain on the search list (CSC_NAME, e.g. the login keychain):
// a certificate passed as CSC_LINK lives in electron-builder's temporary keychain, which is gone
// once electron-builder exits. Notarization reuses electron-builder's variables: APPLE_API_KEY +
// APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,
// or APPLE_KEYCHAIN_PROFILE (+ APPLE_KEYCHAIN). Credential values never appear in output: the
// echoed command lines show "***" instead, and the API key file is passed by path, never read.
import { must } from './release-lib.mjs';

export const IDENTITY_PREFIX = 'Developer ID Application: ';

/** notarytool credential arguments and their redacted display form, or null without credentials. */
export function notaryCredentials(env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return {
      kind: 'App Store Connect API key',
      args: ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER],
      display: ['--key', '***', '--key-id', '***', '--issuer', '***'],
    };
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      kind: 'Apple ID',
      args: ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID],
      display: ['--apple-id', '***', '--password', '***', '--team-id', '***'],
    };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    const keychain = env.APPLE_KEYCHAIN ? ['--keychain', env.APPLE_KEYCHAIN] : [];
    return {
      kind: 'keychain profile',
      args: ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE, ...keychain],
      display: ['--keychain-profile', '***', ...(keychain.length ? ['--keychain', '***'] : [])],
    };
  }
  return null;
}

/**
 * The SHA-1 and full name of the Developer ID Application identity named by CSC_NAME ("Your Name
 * (TEAMID)", with or without the "Developer ID Application: " prefix) among the valid code-signing
 * identities of the keychain search list.
 */
export function findSigningIdentity({ name, run }) {
  const wanted = String(name ?? '').trim();
  if (!wanted) throw new Error('no signing identity name (CSC_NAME) given');
  const full = wanted.startsWith(IDENTITY_PREFIX) ? wanted : `${IDENTITY_PREFIX}${wanted}`;
  const out = must(run, 'security', ['find-identity', '-v', '-p', 'codesigning'], { quiet: true });
  for (const line of out.split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (m && m[2] === full) {
      const team = /\(([A-Z0-9]{10})\)$/.exec(m[2])?.[1] ?? null;
      return { hash: m[1], name: m[2], team };
    }
  }
  throw new Error(`no valid "${IDENTITY_PREFIX}…" identity matching CSC_NAME in the keychain search list (security find-identity -v -p codesigning)`);
}

function lastLines(text, n = 4) {
  return String(text ?? '').trim().split('\n').slice(-n).join(' | ');
}

/**
 * Sign → notarize → staple → verify one DMG. Returns the report entry; throws on the first step
 * that fails (the report then says which: `failedAt`).
 */
export function signAndNotarizeDmg({ dmg, identity, credentials, run, log = () => undefined }) {
  const report = { file: dmg.split(/[\\/]/).pop(), ok: false, identity: identity.name, team: identity.team, timestamp: false, notarization: null, stapled: false, spctl: null, staplerValidate: null, failedAt: null };
  const step = (name, fn) => {
    try {
      return fn();
    } catch (error) {
      report.failedAt = name;
      report.error = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(`${report.file}: ${name} failed: ${report.error}`), { report });
    }
  };

  step('sign', () => {
    must(run, 'codesign', ['--force', '--timestamp', '--sign', identity.hash, dmg]);
    const details = run('codesign', ['-dvvv', dmg], { quiet: true });
    const text = `${details.stdout}${details.stderr}`;
    report.timestamp = /^Timestamp=/m.test(text);
    if (!report.timestamp) throw new Error('the DMG signature has no secure timestamp');
  });

  step('notarize', () => {
    log(`  notarizing ${report.file} with ${credentials.kind} (Apple's notary service usually answers within minutes)…`);
    const r = run('xcrun', ['notarytool', 'submit', dmg, ...credentials.args, '--wait', '--output-format', 'json'], { display: ['notarytool', 'submit', dmg, ...credentials.display, '--wait', '--output-format', 'json'] });
    let answer = null;
    try {
      answer = JSON.parse(r.stdout);
    } catch {
      // not JSON: notarytool failed before talking to Apple (credentials, network)
    }
    report.notarization = answer ? { id: answer.id ?? null, status: answer.status ?? null } : null;
    if (answer?.status !== 'Accepted') {
      let issues = '';
      if (answer?.id) {
        const logOut = run('xcrun', ['notarytool', 'log', answer.id, ...credentials.args], { display: ['notarytool', 'log', answer.id, ...credentials.display], quiet: true });
        try {
          const parsed = JSON.parse(logOut.stdout);
          issues = (parsed.issues ?? [])
            .slice(0, 5)
            .map((i) => `${i.path ?? ''}: ${i.message ?? ''}`.trim())
            .join('; ');
        } catch {
          issues = lastLines(logOut.stdout || logOut.stderr);
        }
        report.notarization.issues = issues || null;
      }
      throw new Error(`notary service status ${answer?.status ?? 'unknown'}${answer?.message ? ` (${answer.message})` : ''}${issues ? `: ${issues}` : ''}${answer ? '' : `: ${lastLines(r.stderr || r.stdout)}`}`);
    }
  });

  step('staple', () => {
    must(run, 'xcrun', ['stapler', 'staple', dmg]);
    report.stapled = true;
  });

  step('verify', () => {
    const validate = run('xcrun', ['stapler', 'validate', dmg]);
    report.staplerValidate = validate.status === 0 ? 'ok' : `failed: ${lastLines(validate.stderr || validate.stdout)}`;
    const spctl = run('spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmg]);
    const text = `${spctl.stderr}${spctl.stdout}`;
    report.spctl = `${spctl.status === 0 ? 'accepted' : 'rejected'}: ${(/source=([^\n]+)/.exec(text)?.[1] ?? lastLines(text, 1)).trim()}`;
    if (validate.status !== 0) throw new Error(`stapler validate: ${report.staplerValidate}`);
    if (spctl.status !== 0 || !/source=Notarized Developer ID/.test(text)) throw new Error(`spctl: ${report.spctl}`);
  });

  report.ok = true;
  return report;
}
