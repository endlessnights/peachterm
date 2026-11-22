import { useRef } from 'react';
import { Dialog } from '../../components/Dialog';
import { useTabs } from './store';

/** Changes only this tab's label; the saved connection is untouched. */
export function RenameTabDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
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
      title="Rename tab"
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
            title="Use the saved connection's name again"
          >
            Reset to “{tab.defaultTitle}”
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            Rename
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
          <span>Tab name</span>
          <input
            ref={input}
            className="input"
            defaultValue={tab.title}
            maxLength={128}
            data-autofocus
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <p className="hint">
          Only this tab is renamed. The saved connection and other sessions keep their names.
        </p>
      </form>
    </Dialog>
  );
}
