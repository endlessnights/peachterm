// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Settings → About: who made PeachTerm, which version this is, and under what
// license. Links open in the default browser through a fixed list in Rust.

import { useTranslation } from 'react-i18next';
import { t as tr } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
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
  if (checking) return tr('about.checking');
  switch (phase) {
    case 'upToDate':
      return tr('about.upToDate');
    case 'available':
      return version ? tr('about.availableVersion', { version }) : tr('app.updateAvailable');
    case 'downloading':
      return tr('update.downloading');
    case 'ready':
      return tr('about.readyInstall');
    case 'installing':
      return tr('about.installing');
    case 'failed':
      return tr('about.failed');
    case 'unavailable':
      return tr('about.unavailable');
    default:
      return tr('about.notChecked');
  }
}

const when = (seconds: number | null | undefined) =>
  seconds ? formatDateTime(seconds * 1000) : tr('about.never');

function UpdatesSection() {
  const { t } = useTranslation();
  const { phase, checking, info, status, problem, check, openNotes, openNotice } = useUpdates();
  useEffect(() => {
    void useUpdates.getState().refresh();
  }, []);
  const waiting = phase === 'available' || phase === 'ready' || phase === 'downloading';
  return (
    <section className="about-updates">
      <h3>{t('about.updates')}</h3>
      <dl className="about-list">
        <dt>{t('about.status')}</dt>
        <dd data-testid="update-status">{statusText(phase, checking, info?.version)}</dd>
        <dt>{t('about.lastChecked')}</dt>
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
          {t('about.check')}
        </button>
        {waiting && (
          <>
            <button className="btn" onClick={openNotes}>
              {t('update.releaseNotes')}
            </button>
            <button className="btn" onClick={openNotice}>
              {t('about.showUpdate')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export function AboutPage() {
  const { t } = useTranslation();
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
      <h3>{t('about.heading')}</h3>
      <p className="about-name">
        <strong>PeachTerm</strong> <span data-testid="about-version">{version ?? ''}</span>
      </p>
      <p>{t('about.created')}</p>
      <UpdatesSection />
      <h3>{t('about.links')}</h3>
      <dl className="about-list about-links">
        <dt>{t('about.license')}</dt>
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
        <dt>{t('about.source')}</dt>
        <dd>
          <ProjectLink to="repository" href="https://github.com/endlessnights/peachterm">
            https://github.com/endlessnights/peachterm
          </ProjectLink>
        </dd>
        <dt>{t('about.notices')}</dt>
        <dd>
          <ProjectLink
            to="notices"
            href="https://github.com/endlessnights/peachterm/blob/main/THIRD_PARTY_NOTICES.md"
          >
            {t('about.noticesLink')}
          </ProjectLink>
        </dd>
      </dl>
      <p className="hint">{t('about.copyright')}</p>
    </div>
  );
}
