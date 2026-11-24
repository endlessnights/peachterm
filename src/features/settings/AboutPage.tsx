// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Settings → About: who made PeachTerm, which version this is, and under what
// license. Links open in the default browser through a fixed list in Rust.

import { useEffect, useState } from 'react';
import { reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';
import { updateProblem, useUpdates, type UpdatePhase } from '../updates/store';

type LinkKey = Parameters<typeof ipc.openLink>[0];

function ProjectLink({ to, href, children }: { to: LinkKey; href: string; children: string }) {
  return (
    <a
      className="about-link"
      href={href}
      onClick={(e) => {
        // never navigate the app's own window
        e.preventDefault();
        ipc.openLink(to).catch(reportError);
      }}
    >
      {children}
    </a>
  );
}

function statusText(phase: UpdatePhase, checking: boolean, version: string | undefined) {
  if (checking) return 'Checking…';
  switch (phase) {
    case 'upToDate':
      return 'Up to date';
    case 'available':
      return `Update available${version ? `: PeachTerm ${version}` : ''}`;
    case 'downloading':
      return 'Downloading…';
    case 'ready':
      return 'Ready to install';
    case 'installing':
      return 'Installing…';
    case 'failed':
      return 'Update failed';
    case 'unavailable':
      return 'Update check unavailable';
    default:
      return 'Not checked yet';
  }
}

const when = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000).toLocaleString() : 'Never';

function UpdatesSection() {
  const { phase, checking, info, status, problem, check, openNotes, openNotice } = useUpdates();
  useEffect(() => {
    void useUpdates.getState().refresh();
  }, []);
  const waiting = phase === 'available' || phase === 'ready' || phase === 'downloading';
  return (
    <section className="about-updates">
      <h3>Updates</h3>
      <dl className="about-list">
        <dt>Status</dt>
        <dd data-testid="update-status">{statusText(phase, checking, info?.version)}</dd>
        <dt>Last checked</dt>
        <dd data-testid="update-last-check">{when(status?.lastCheckAt)}</dd>
      </dl>
      {problem && (phase === 'failed' || phase === 'unavailable') && (
        <p className="hint" role="status">
          {updateProblem(problem)}
        </p>
      )}
      <div className="update-actions" style={{ justifyContent: 'flex-start' }}>
        <button
          className="btn"
          disabled={checking || phase === 'downloading'}
          onClick={() => void check(true)}
        >
          Check for Updates
        </button>
        {waiting && (
          <>
            <button className="btn" onClick={openNotes}>
              Release Notes
            </button>
            <button className="btn" onClick={openNotice}>
              Show Update…
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export function AboutPage() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    ipc
      .appInfo()
      .then((info) => live && setVersion(info.version))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="about">
      <h3>About PeachTerm</h3>
      <p className="about-name">
        <strong>PeachTerm</strong> <span data-testid="about-version">{version ?? ''}</span>
      </p>
      <p>Created by Bakhti Baymukhamedov.</p>
      <UpdatesSection />
      <h3>Links</h3>
      <dl className="about-list about-links">
        <dt>License</dt>
        <dd>
          <ProjectLink
            to="license"
            href="https://github.com/endlessnights/peachterm/blob/main/LICENSE"
          >
            Apache-2.0
          </ProjectLink>
        </dd>
        <dt>GitHub</dt>
        <dd>
          <ProjectLink to="github" href="https://github.com/endlessnights">
            https://github.com/endlessnights
          </ProjectLink>
        </dd>
        <dt>Telegram</dt>
        <dd>
          <ProjectLink to="telegram" href="https://t.me/pycarrot2">
            https://t.me/pycarrot2
          </ProjectLink>
        </dd>
        <dt>Source code</dt>
        <dd>
          <ProjectLink to="repository" href="https://github.com/endlessnights/peachterm">
            https://github.com/endlessnights/peachterm
          </ProjectLink>
        </dd>
        <dt>Notices</dt>
        <dd>
          <ProjectLink
            to="notices"
            href="https://github.com/endlessnights/peachterm/blob/main/THIRD_PARTY_NOTICES.md"
          >
            Open-source license notices
          </ProjectLink>
        </dd>
      </dl>
      <p className="hint">
        Copyright 2026 Bakhti Baymukhamedov. PeachTerm is free software under the Apache License,
        Version 2.0, built with open-source components that keep their own licenses.
      </p>
    </div>
  );
}
