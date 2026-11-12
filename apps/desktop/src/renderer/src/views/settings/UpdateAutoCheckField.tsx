import type { Settings, SettingsPatch } from '@orbitdrop/contracts';
import { useId } from 'react';
import { useEnv } from '../../app/env';
import './update.css';

/**
 * Settings › 일반: "업데이트 자동 확인" (settings.updates.autoCheck) with one line on what a check
 * sends to GitHub. Off stops the automatic checks; "지금 확인" in About still works.
 */
export function UpdateAutoCheckField({ settings, apply }: { readonly settings: Settings; readonly apply: (patch: SettingsPatch) => void }) {
  const { t } = useEnv();
  const hintId = useId();
  return (
    <div className="settings-field update-autocheck">
      <label className="checkbox-row settings-checkbox">
        <input
          type="checkbox"
          role="switch"
          checked={settings.updates.autoCheck}
          aria-describedby={hintId}
          onChange={(event) => apply({ updates: { autoCheck: event.target.checked } })}
        />
        <span>{t('update.settings.autoCheck')}</span>
      </label>
      <p className="settings-hint" id={hintId}>
        {t('update.settings.privacy')}
      </p>
    </div>
  );
}
