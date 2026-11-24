// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Dialog } from '../../components/Dialog';
import { quitNow, useExit } from './exit';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ExitDialog() {
  const summary = useExit((s) => s.summary);
  const cancel = useExit((s) => s.cancel);
  if (!summary) return null;
  const lines: string[] = [];
  if (summary.sshActive > 0) {
    lines.push(
      `${plural(summary.sshActive, 'active SSH session', 'active SSH sessions')} will be disconnected.`,
    );
  }
  if (summary.tunnels > 0) {
    lines.push(`${plural(summary.tunnels, 'SSH tunnel', 'SSH tunnels')} will be stopped.`);
  }
  if (summary.localActive > 0) {
    lines.push(
      `${plural(summary.localActive, 'local terminal', 'local terminals')} will be closed and the programs running in ${summary.localActive === 1 ? 'it' : 'them'} stopped.`,
    );
  }
  if (summary.connecting > 0) {
    lines.push(
      `${plural(summary.connecting, 'connection', 'connections')} still being established will be cancelled.`,
    );
  }
  if (summary.transfers > 0) {
    lines.push(
      `${plural(summary.transfers, 'file transfer', 'file transfers')} in progress will be interrupted.`,
    );
  }
  if (summary.pendingUploads > 0) {
    lines.push(
      `${plural(summary.pendingUploads, 'edited file', 'edited files')} not yet uploaded. The local copy is kept; the remote file is not changed.`,
    );
  }
  if (summary.unsavedConnection) lines.push('The connection dialog has unsaved changes.');
  if (summary.unsavedSettings) lines.push('The settings dialog has unsaved changes.');
  return (
    <Dialog
      title="Exit PeachTerm?"
      onClose={cancel}
      footer={
        <>
          {/* Cancel is the default answer: Enter and Esc keep the application open. */}
          <button className="btn btn-primary" onClick={cancel} data-autofocus>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={quitNow}>
            Exit PeachTerm
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p>If you exit now:</p>
        <ul className="exit-list" aria-label="What exiting will end">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
