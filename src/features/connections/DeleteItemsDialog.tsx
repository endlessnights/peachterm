import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { notify, reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import type { DeletePlan, FolderDeleteMode, ItemRef } from '../../shared/types';
import { useTabs } from '../sessions/store';
import { useConnections } from './store';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One consolidated confirmation for deleting any number of connections and
 * folders. The counts come from the backend, which also performs the deletion.
 */
export function DeleteItemsDialog({ items, onClose }: { items: ItemRef[]; onClose: () => void }) {
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
      const parts = [
        outcome.plan.connectionIds.length > 0 &&
          plural(outcome.plan.connectionIds.length, 'connection'),
        outcome.plan.folderIds.length > 0 && plural(outcome.plan.folderIds.length, 'folder'),
      ].filter(Boolean);
      notify(`Deleted ${parts.join(' and ')}.`);
      if (outcome.credentialFailures > 0) {
        reportError({
          code: 'credentials',
          message: `${plural(outcome.credentialFailures, 'saved password')} could not be removed from the system keychain.`,
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
        ? 'Delete folder'
        : 'Delete connection'
      : `Delete ${items.length} items`;

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void confirm()}
            disabled={busy || !plan}
          >
            Delete
          </button>
        </>
      }
    >
      <div className="dialog-body" role="alertdialog" aria-label={title}>
        <div>
          You selected{' '}
          <strong>
            {[
              selectedConnections > 0 && plural(selectedConnections, 'connection'),
              selectedFolders > 0 && plural(selectedFolders, 'folder'),
            ]
              .filter(Boolean)
              .join(' and ')}
          </strong>
          {names && <span className="hint"> ({names})</span>}.
        </div>

        {selectedFolders > 0 && (
          <fieldset className="delete-mode">
            <legend>What should happen to the contents of the folders?</legend>
            <label className="check">
              <input
                type="radio"
                name="mode"
                checked={mode === 'moveToParent'}
                onChange={() => setMode('moveToParent')}
              />
              Keep them: move connections and sub-folders to the parent folder
            </label>
            <label className="check">
              <input
                type="radio"
                name="mode"
                checked={mode === 'deleteContents'}
                onChange={() => setMode('deleteContents')}
              />
              Delete the folders together with everything inside them
            </label>
          </fieldset>
        )}

        {plan && (
          <div className="notice" role="status">
            This will delete{' '}
            <strong>
              {plural(doomedConnections, 'connection')}
              {doomedFolders > 0 && ` and ${plural(doomedFolders, 'folder')}`}
            </strong>
            {(plan.movedConnections > 0 || plan.movedFolders > 0) && (
              <>
                {' '}
                and move{' '}
                {[
                  plan.movedConnections > 0 && plural(plan.movedConnections, 'connection'),
                  plan.movedFolders > 0 && plural(plan.movedFolders, 'folder'),
                ]
                  .filter(Boolean)
                  .join(' and ')}{' '}
                up one level
              </>
            )}
            . Each deleted connection&apos;s saved password is removed from the system keychain; no
            other credentials or files are touched. This cannot be undone.
          </div>
        )}
        {openTabs > 0 && (
          <div className="notice notice-warn" role="status">
            {plural(openTabs, 'open tab')} use these connections. They stay open and keep running;
            only the saved entries are deleted.
          </div>
        )}
      </div>
    </Dialog>
  );
}
