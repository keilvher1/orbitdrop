import type { Settings, SettingsPatch } from '@orbitdrop/contracts';
import { describeError, silentLogger, type Logger } from './log';

/**
 * First-run flow after the UI started (kept free of runtime Electron imports):
 *  1. macOS, packaged, outside the Applications folder (run from the DMG,
 *     Downloads…): offer once to move the app there (이동 / 나중에). Moving
 *     relaunches OrbitDrop from Applications, which continues with step 2.
 *  2. The welcome window, until it was closed once (settings
 *     onboarding.welcomeDone; a first run has no settings file yet, so it
 *     starts false; files from before the welcome existed load as done).
 * Automation (E2E, smoke test) never shows either.
 */
export interface MoveToApplications {
  /** Packaged macOS app outside /Applications and ~/Applications. */
  needed(): boolean;
  /** Ask: true = move now, false = later. */
  ask(): Promise<boolean>;
  /** app.moveToApplicationsFolder(): true when it moved (the app then quits and relaunches from there). */
  move(): boolean;
}

export interface OnboardingDeps {
  readonly settings: { get(): Settings; update(patch: SettingsPatch): Promise<Settings> };
  /** E2E runs and the smoke test: no first-run UI. */
  readonly automated: boolean;
  /** Null where it does not apply (Windows, development builds). */
  readonly moveToApplications: MoveToApplications | null;
  readonly openWelcome: () => void;
  readonly log?: Logger;
}

export type OnboardingOutcome = 'none' | 'moved' | 'welcome';

export async function runOnboarding(deps: OnboardingDeps): Promise<OnboardingOutcome> {
  const log = deps.log ?? silentLogger;
  if (deps.automated) return 'none';
  const offer = deps.moveToApplications;
  if (offer !== null && !deps.settings.get().onboarding.moveToApplicationsAsked && offer.needed()) {
    // Asked once, whatever the answer (also if the app is quit while the question is open).
    await deps.settings.update({ onboarding: { moveToApplicationsAsked: true } }).catch((error: unknown) => {
      log.warn('could not store the move offer', { error: describeError(error) });
    });
    let move = false;
    try {
      move = await offer.ask();
    } catch (error) {
      log.warn('could not ask about moving to Applications', { error: describeError(error) });
    }
    if (move) {
      try {
        if (offer.move()) {
          log.info('moved to the Applications folder; relaunching from there');
          return 'moved';
        }
        log.info('the move to Applications was cancelled');
      } catch (error) {
        log.warn('could not move to the Applications folder', { error: describeError(error) });
      }
    }
  }
  if (!deps.settings.get().onboarding.welcomeDone) {
    deps.openWelcome();
    return 'welcome';
  }
  return 'none';
}
