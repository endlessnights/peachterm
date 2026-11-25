// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Icon } from '../../components/Icon';
import { leaves, shownTabs } from '../sessions/layout';
import { useTabs } from '../sessions/store';
import { useTranslation } from 'react-i18next';

/**
 * Shown in a new pane: start a NEW session like the one next to it, show an
 * open tab that is not visible yet, or remove the pane. Sessions are never
 * closed by any of these.
 */
export function PanePicker({ leafId }: { leafId: string }) {
  const { t } = useTranslation();
  const tabs = useTabs((s) => s.tabs);
  const layout = useTabs((s) => s.layout);
  const fillLeaf = useTabs((s) => s.fillLeaf);
  const fillLeafWithNewSession = useTabs((s) => s.fillLeafWithNewSession);
  const removePane = useTabs((s) => s.removePane);
  if (!layout) return null;
  const visible = new Set(shownTabs(layout));
  const hidden = tabs.filter((t) => !visible.has(t.id));
  const leaf = leaves(layout).find((l) => l.id === leafId);
  const source =
    tabs.find((t) => t.id === leaf?.sourceTabId) ??
    tabs.find((t) => t.id === useTabs.getState().activeId) ??
    tabs[0];
  return (
    <div className="pane-picker" role="group" aria-label={t('pane.group')}>
      <h3>{t('pane.heading')}</h3>
      <button
        className="btn btn-primary"
        onClick={() => fillLeafWithNewSession(leafId)}
        data-autofocus
      >
        <Icon name="plus" />{' '}
        {source ? t('pane.newSessionNamed', { title: source.title }) : t('pane.newSession')}
      </button>
      {hidden.length > 0 && <div className="pane-picker-label">{t('pane.orOpen')}</div>}
      <ul>
        {hidden.map((tab) => (
          <li key={tab.id}>
            <button className="pane-picker-row" onClick={() => fillLeaf(leafId, tab.id)}>
              <span className="status-dot" data-status={tab.status} />
              <span className="pane-picker-title">{tab.title}</span>
              <span className="pane-picker-sub">{tab.subtitle}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="btn" onClick={() => removePane(leafId)}>
        {t('common.cancel')}
      </button>
    </div>
  );
}
