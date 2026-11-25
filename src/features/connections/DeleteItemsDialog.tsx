// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Trans, useTranslation } from 'react-i18next';
import { t as tr } from '../../i18n';
import { formatList } from '../../i18n/format';
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { notify, reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import type { DeletePlan, FolderDeleteMode, ItemRef } from '../../shared/types';
import { useTabs } from '../sessions/store';
import { useConnections } from './store';

const counts = (connections: number, folders: number): string[] =>
  [
    connections > 0 && tr('count.connection', { count: connections }),
    folders > 0 && tr('count.folder', { count: folders }),
  ].filter((part): part is string => typeof part === 'string');

/**
 * One consolidated confirmation for deleting any number of connections and
 * folders. The counts come from the backend, which also performs the deletion.
 */
export function DeleteItemsDialog({ items, onClose }: { items: ItemRef[]; onClose: () => void }) {
  const { t } = useTranslation();
  const tree = useConnections((s) => s.tree);
  const deleteItems = useConnections((s) => s.deleteItems);
  const tabs = useTabs((s) => s.tabs);
  const [mode, setMode] = useState<FolderDeleteMode>('moveToParent');
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedFolders = items.filter((i) => i.kind === 'folder').length;
  const selectedConnections = items.length - selectedFolders;

  useEffect(() => {
    let current = true;
    ipc
      .treeDeletePreview(items, mode)
      .then((p) => current && setPlan(p))
      .catch(reportError);
    return () => {
      current = false;
    };
  }, [items, mode]);

  const openTabs = useMemo(() => {
    if (!plan) return 0;
    const doomed = new Set(plan.connectionIds);
    return tabs.filter((t) => doomed.has(t.connectionId)).length;
  }, [plan, tabs]);

  const names = useMemo(() => {
    const list = items
      .slice(0, 3)
      .map((i) =>
        i.kind === 'folder'
          ? tree.folders.find((f) => f.id === i.id)?.name
          : tree.connections.find((c) => c.id === i.id)?.name,
      );
    return list.filter(Boolean).join(', ') + (items.length > 3 ? ', …' : '');
  }, [items, tree]);

  const confirm = async () => {
    setBusy(true);
    try {
      const outcome = await deleteItems(items, mode);
      notify(
        t('conn.delete.deleted', {
          what: formatList(
            counts(outcome.plan.connectionIds.length, outcome.plan.folderIds.length),
          ),
        }),
      );
      if (outcome.credentialFailures > 0) {
        reportError({
          code: 'credentials',
          message: t('conn.delete.keychainFailed', { count: outcome.credentialFailures }),
        });
      }
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const doomedConnections = plan?.connectionIds.length ?? 0;
  const doomedFolders = plan?.folderIds.length ?? 0;
  const title =
    items.length === 1
      ? selectedFolders
        ? t('conn.delete.titleFolder')
        : t('conn.delete.titleConnection')
      : t('conn.delete.titleMany', { count: items.length });

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} data-autofocus>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void confirm()}
            disabled={busy || !plan}
          >
            {t('conn.delete.submit')}
          </button>
        </>
      }
    >
      <div className="dialog-body" role="alertdialog" aria-label={title}>
        <div>
          <Trans
            i18nKey="conn.delete.selected"
            values={{ what: formatList(counts(selectedConnections, selectedFolders)) }}
            components={{ strong: <strong /> }}
          />
          {names && <span className="hint"> ({names})</span>}.
        </div>

        {selectedFolders > 0 && (
          <fieldset className="delete-mode">
            <legend>{t('conn.delete.contentsQuestion')}</legend>
            <label className="check">
              <input
                type="radio"
                name="mode"
                checked={mode === 'moveToParent'}
                onChange={() => setMode('moveToParent')}
              />
              {t('conn.delete.keep')}
            </label>
            <label className="check">
              <input
                type="radio"
                name="mode"
                checked={mode === 'deleteContents'}
                onChange={() => setMode('deleteContents')}
              />
              {t('conn.delete.all')}
            </label>
          </fieldset>
        )}

        {plan && (
          <div className="notice" role="status">
            <Trans
              i18nKey={
                plan.movedConnections > 0 || plan.movedFolders > 0
                  ? 'conn.delete.willDeleteMove'
                  : 'conn.delete.willDelete'
              }
              values={{
                deleted: formatList([
                  tr('count.connection', { count: doomedConnections }),
                  ...(doomedFolders > 0 ? [tr('count.folder', { count: doomedFolders })] : []),
                ]),
                moved: formatList(counts(plan.movedConnections, plan.movedFolders)),
              }}
              components={{ strong: <strong /> }}
            />{' '}
            {t('conn.delete.consequence')}
          </div>
        )}
        {openTabs > 0 && (
          <div className="notice notice-warn" role="status">
            {t('conn.delete.openTabs', { count: openTabs })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
