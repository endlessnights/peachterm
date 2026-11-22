// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { useSettings } from '../settings/store';
import { PRESETS, PRESET_ORDER, effectivePreset } from '../terminal/palettes';
import { useTabs } from './store';

/**
 * Terminal colours for ONE tab. The choice changes nothing else: not the
 * application theme, not other tabs, not the connection, and the session keeps
 * running (only the xterm colours are swapped).
 */
export function TabColorsDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
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
      title="Terminal colours"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={apply}>
            OK
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="hint">
          Applies to “{tab.title}” only, without reconnecting. The application theme and other tabs
          are not changed.
        </p>
        <div role="radiogroup" aria-label="Terminal colours for this tab" className="radio-list">
          <label className="check">
            <input
              type="radio"
              name="tab-colors"
              checked={choice === null}
              onChange={() => setChoice(null)}
            />
            Follow Global Theme ({global})
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
