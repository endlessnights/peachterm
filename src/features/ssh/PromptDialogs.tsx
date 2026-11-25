// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Trans, useTranslation } from 'react-i18next';
import { useRef } from 'react';
import { Dialog } from '../../components/Dialog';
import type { SshPrompt } from '../../shared/types';
import { usePrompts } from './promptStore';

type HostKeyPrompt = Extract<SshPrompt, { kind: 'hostKey' }>;
type AuthPrompt = Extract<SshPrompt, { kind: 'auth' }>;

/** Shows the oldest pending question; the rest wait their turn. */
export function SshPromptHost() {
  const prompt = usePrompts((s) => s.queue[0]);
  if (!prompt) return null;
  return prompt.kind === 'hostKey' ? (
    <HostKeyDialog key={prompt.promptId} prompt={prompt} />
  ) : (
    <AuthDialog key={prompt.promptId} prompt={prompt} />
  );
}

function HostKeyDialog({ prompt }: { prompt: HostKeyPrompt }) {
  const { t } = useTranslation();
  const answer = usePrompts((s) => s.answerHostKey);
  const changed = prompt.previousFingerprint !== null;
  const where = `${prompt.host}:${prompt.port}`;
  const reject = () => void answer(prompt.promptId, 'reject');
  return (
    <Dialog
      title={changed ? t('ssh.hostKey.changedTitle') : t('ssh.hostKey.unknownTitle')}
      onClose={reject}
      persistent
      footer={
        changed ? (
          <>
            <button className="btn" onClick={() => void answer(prompt.promptId, 'replace')}>
              {t('ssh.hostKey.replace')}
            </button>
            <button className="btn btn-primary" onClick={reject} data-autofocus>
              {t('ssh.hostKey.disconnect')}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={reject}>
              {t('ssh.hostKey.reject')}
            </button>
            <button className="btn" onClick={() => void answer(prompt.promptId, 'trustOnce')}>
              {t('ssh.hostKey.once')}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void answer(prompt.promptId, 'trustAndSave')}
              data-autofocus
            >
              {t('ssh.hostKey.trustSave')}
            </button>
          </>
        )
      }
    >
      <div className="dialog-body">
        {changed ? (
          <p className="callout callout-danger">
            <Trans
              i18nKey="ssh.hostKey.changedBody"
              values={{ where }}
              components={{ strong: <strong /> }}
            />
          </p>
        ) : (
          <p>
            <Trans
              i18nKey="ssh.hostKey.unknownBody"
              values={{ where }}
              components={{ strong: <strong /> }}
            />
          </p>
        )}
        <dl className="fingerprint">
          <dt>{t('ssh.hostKey.algorithm')}</dt>
          <dd>{prompt.algorithm}</dd>
          {changed && (
            <>
              <dt>{t('ssh.hostKey.saved')}</dt>
              <dd className="mono">{prompt.previousFingerprint}</dd>
            </>
          )}
          <dt>{changed ? t('ssh.hostKey.new') : t('ssh.hostKey.fingerprint')}</dt>
          <dd className="mono">{prompt.fingerprint}</dd>
        </dl>
      </div>
    </Dialog>
  );
}

function AuthDialog({ prompt }: { prompt: AuthPrompt }) {
  const { t } = useTranslation();
  const answer = usePrompts((s) => s.answerAuth);
  // Kept in refs so a typed secret never sits in React state or a store.
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const cancel = () => void answer(prompt.promptId, null);
  const submit = () => {
    const given = prompt.prompts.map((_, i) => inputs.current[i]?.value ?? '');
    inputs.current.forEach((input) => {
      if (input) input.value = '';
    });
    void answer(prompt.promptId, given);
  };
  return (
    <Dialog
      title={prompt.name || t(`ssh.auth.${prompt.method}`)}
      onClose={cancel}
      persistent
      footer={
        <>
          <button className="btn" onClick={cancel}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {t('settings.ok')}
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
        {prompt.retry && (
          <p className="callout callout-danger" role="alert">
            {t('ssh.auth.retry')}
          </p>
        )}
        {prompt.instructions && <p>{prompt.instructions}</p>}
        {prompt.prompts.map((line, i) => (
          <label className="field" key={i}>
            <span>{line.text}</span>
            <input
              ref={(el) => {
                inputs.current[i] = el;
              }}
              className="input"
              type={line.echo ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              data-autofocus={i === 0 ? true : undefined}
            />
          </label>
        ))}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
