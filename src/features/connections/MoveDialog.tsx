import { useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { reportError } from '../../components/Toasts';
import type { ItemRef, Uuid } from '../../shared/types';
import { useConnections } from './store';
import { folderLevel, normalizeItems, validateMove } from './treeOps';

interface Option {
  id: Uuid | null;
  label: string;
  depth: number;
  reason: string | null;
}

/**
 * Keyboard-accessible alternative to drag-and-drop: choose the destination
 * folder from a list. Destinations that would break a rule are disabled and
 * say why.
 */
export function MoveDialog({ items, onClose }: { items: ItemRef[]; onClose: () => void }) {
  const tree = useConnections((s) => s.tree);
  const moveItems = useConnections((s) => s.moveItems);
  const [choice, setChoice] = useState<Uuid | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    const out: Option[] = [
      { id: null, label: 'Top level', depth: 0, reason: validateMove(tree, items, null) },
    ];
    const walk = (parent: Uuid | null) => {
      const children = tree.folders
        .filter((f) => f.parentId === parent)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      for (const folder of children) {
        out.push({
          id: folder.id,
          label: folder.name,
          depth: folderLevel(tree, folder.id),
          reason: validateMove(tree, items, folder.id),
        });
        walk(folder.id);
      }
    };
    walk(null);
    return out;
  }, [tree, items]);

  const count = normalizeItems(tree, items, true).length;
  const submit = async () => {
    if (choice === undefined) return;
    setBusy(true);
    try {
      await moveItems(items, choice, null);
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={count === 1 ? 'Move to…' : `Move ${count} items to…`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={choice === undefined || busy}
            onClick={() => void submit()}
          >
            Move
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <div className="hint">
          Folders can be nested up to 3 levels deep. Moving never changes a connection&apos;s host,
          user or saved password.
        </div>
        <div role="radiogroup" aria-label="Destination folder" className="move-list">
          {options.map((o) => (
            <label
              key={o.id ?? 'root'}
              className="move-option"
              style={{ paddingLeft: 8 + o.depth * 16 }}
              data-disabled={o.reason ? 'true' : undefined}
            >
              <input
                type="radio"
                name="destination"
                disabled={!!o.reason}
                checked={choice === o.id}
                onChange={() => setChoice(o.id)}
                data-autofocus={o.id === null && !o.reason ? true : undefined}
              />
              <span>{o.label}</span>
              {o.reason && <span className="hint move-reason">{o.reason}</span>}
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
