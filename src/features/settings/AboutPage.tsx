// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Settings → About: who made PeachTerm, which version this is, and under what
// license. Links open in the default browser through a fixed list in Rust.

import { useEffect, useState } from 'react';
import { reportError } from '../../components/Toasts';
import { ipc } from '../../shared/ipc';

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
    <>
      <h3>About PeachTerm</h3>
      <p className="about-name">
        <strong>PeachTerm</strong> <span data-testid="about-version">{version ?? ''}</span>
      </p>
      <p>Created by Bakhti Baymukhamedov.</p>
      <dl className="about-list">
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
    </>
  );
}
