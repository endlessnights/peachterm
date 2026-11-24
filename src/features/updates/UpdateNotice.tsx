// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Dialog } from '../../components/Dialog';
import { useUpdates, updateProblem } from './store';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** First meaningful line of the release notes, kept short. */
function summaryOf(notes: string | null): string {
  // the first line of prose: headings and list markers are skipped
  const line = (notes ?? '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^[>*\-\s]+/, '').trim())
    .find((l) => l.length > 0);
  return line
    ? line.length > 140
      ? `${line.slice(0, 137)}…`
      : line
    : 'Bug fixes and improvements.';
}

/**
 * The compact, non-modal notice. It opens once per new version (and when the user
 * clicks the small indicator); "Later" closes it and leaves only the indicator.
 */
export function UpdateNotice() {
  const phase = useUpdates((s) => s.phase);
  const open = useUpdates((s) => s.noticeOpen);
  const info = useUpdates((s) => s.info);
  const status = useUpdates((s) => s.status);
  const progress = useUpdates((s) => s.progress);
  const problem = useUpdates((s) => s.problem);
  const { closeNotice, download, requestInstall, openNotes } = useUpdates.getState();
  if (!open || !info || phase === 'idle' || phase === 'upToDate') return null;

  const percent =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.floor((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <aside className="update-notice" role="region" aria-label="Software update">
      {phase === 'ready' || phase === 'installing' ? (
        <>
          <strong>PeachTerm {info.version} is ready</strong>
          <p className="hint">
            The update is downloaded and verified. Nothing changes until you install it.
          </p>
          <div className="update-actions">
            <button
              className="btn btn-primary"
              onClick={() => void requestInstall()}
              disabled={phase === 'installing'}
            >
              Install &amp; Restart
            </button>
            <button className="btn" onClick={closeNotice}>
              Later
            </button>
          </div>
        </>
      ) : (
        <>
          <strong>PeachTerm {info.version} is available</strong>
          <p className="hint">Your version: {status?.currentVersion ?? ''}</p>
          <p>{summaryOf(info.notes)}</p>
          {phase === 'downloading' && (
            <p role="status" className="hint">
              {percent === null ? 'Downloading…' : `Downloading… ${percent}%`}
            </p>
          )}
          {problem && <p className="field-error">{updateProblem(problem)}</p>}
          {status && !status.canInstall && (
            <p className="hint">
              This installation (a .deb package) cannot update itself. Download the new package from
              the release page.
            </p>
          )}
          <div className="update-actions">
            <button className="btn" onClick={openNotes}>
              {status && !status.canInstall ? 'Release Page' : 'Release Notes'}
            </button>
            <button className="btn" onClick={closeNotice}>
              Later
            </button>
            {(!status || status.canInstall) && (
              <button
                className="btn btn-primary"
                onClick={() => void download()}
                disabled={phase === 'downloading'}
              >
                Download Update
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

/** Asked before installing when something would be lost. "Install Later" is the default. */
export function InstallConfirm() {
  const summary = useUpdates((s) => s.confirm);
  const info = useUpdates((s) => s.info);
  const { cancelInstall, install } = useUpdates.getState();
  if (!summary) return null;
  const lines: string[] = [];
  if (summary.sshActive > 0)
    lines.push(plural(summary.sshActive, 'active SSH session', 'active SSH sessions'));
  if (summary.tunnels > 0)
    lines.push(plural(summary.tunnels, 'active SSH tunnel', 'active SSH tunnels'));
  if (summary.localActive > 0)
    lines.push(plural(summary.localActive, 'local terminal', 'local terminals'));
  if (summary.connecting > 0)
    lines.push(
      plural(summary.connecting, 'connection being established', 'connections being established'),
    );
  if (summary.transfers > 0)
    lines.push(
      plural(summary.transfers, 'file transfer in progress', 'file transfers in progress'),
    );
  if (summary.pendingUploads > 0)
    lines.push(
      `${plural(summary.pendingUploads, 'edited file', 'edited files')} not yet uploaded (local copies are kept)`,
    );
  if (summary.unsavedConnection) lines.push('unsaved changes in the connection dialog');
  if (summary.unsavedSettings) lines.push('unsaved changes in the settings dialog');
  return (
    <Dialog
      title="Install the update?"
      onClose={cancelInstall}
      footer={
        <>
          <button className="btn btn-primary" onClick={cancelInstall} data-autofocus>
            Install Later
          </button>
          <button className="btn btn-danger" onClick={() => void install()}>
            Install &amp; Restart
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p>PeachTerm {info?.version ?? ''} is ready to install. You currently have:</p>
        <ul className="exit-list" aria-label="What installing will end">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>
          Installing the update closes these sessions and restarts PeachTerm. Live connections are
          not restored afterwards.
        </p>
      </div>
    </Dialog>
  );
}
