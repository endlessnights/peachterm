// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useRef } from 'react';
import { Dialog } from '../../components/Dialog';
import { useTabs } from './store';
import { useTranslation } from 'react-i18next';

/** Changes only this tab's label; the saved connection is untouched. */
export function RenameTabDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const renameTab = useTabs((s) => s.renameTab);
  const input = useRef<HTMLInputElement>(null);
  if (!tab) return null;
  const submit = () => {
    renameTab(tabId, input.current?.value ?? null);
    onClose();
  };
  return (
    <Dialog
      title={t('rename.title')}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn left"
            onClick={() => {
              renameTab(tabId, null);
              onClose();
            }}
            disabled={tab.customTitle === null}
            title={t('rename.resetHint')}
          >
            {t('rename.reset', { name: tab.defaultTitle })}
          </button>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {t('rename.submit')}
          </button>
        </>
      }
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>{t('rename.name')}</span>
          <input
            ref={input}
            className="input"
            defaultValue={tab.title}
            maxLength={128}
            data-autofocus
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <p className="hint">{t('rename.hint')}</p>
      </form>
    </Dialog>
  );
}
