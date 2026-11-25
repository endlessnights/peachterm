// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { useSettings } from '../settings/store';
import { PRESETS, PRESET_ORDER, effectivePreset } from '../terminal/palettes';
import { useTabs } from './store';
import { useTranslation } from 'react-i18next';

/**
 * Terminal colours for ONE tab. The choice changes nothing else: not the
 * application theme, not other tabs, not the connection, and the session keeps
 * running (only the xterm colours are swapped).
 */
export function TabColorsDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const setTabColors = useTabs((s) => s.setTabColors);
  const appearance = useSettings((s) => s.settings.appearance);
  const [choice, setChoice] = useState<string | null>(tab?.colors ?? null);
  if (!tab) return null;
  const global = PRESETS[effectivePreset(appearance)].name;
  const apply = () => {
    setTabColors(tabId, choice);
    onClose();
  };
  return (
    <Dialog
      title={t('tabColors.title')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={apply}>
            {t('settings.ok')}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="hint">{t('tabColors.hint', { title: tab.title })}</p>
        <div role="radiogroup" aria-label={t('tabColors.group')} className="radio-list">
          <label className="check">
            <input
              type="radio"
              name="tab-colors"
              checked={choice === null}
              onChange={() => setChoice(null)}
            />
            {t('tabColors.follow', { name: global })}
          </label>
          {PRESET_ORDER.map((id) => (
            <label className="check" key={id}>
              <input
                type="radio"
                name="tab-colors"
                checked={choice === id}
                onChange={() => setChoice(id)}
              />
              {PRESETS[id].name}
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
