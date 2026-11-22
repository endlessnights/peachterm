// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

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
  const answer = usePrompts((s) => s.answerHostKey);
  const changed = prompt.previousFingerprint !== null;
  const where = `${prompt.host}:${prompt.port}`;
  const reject = () => void answer(prompt.promptId, 'reject');
  return (
    <Dialog
      title={changed ? 'Host key has changed' : 'Unknown host'}
      onClose={reject}
      persistent
      footer={
        changed ? (
          <>
            <button className="btn" onClick={() => void answer(prompt.promptId, 'replace')}>
              Replace saved key and connect
            </button>
            <button className="btn btn-primary" onClick={reject} data-autofocus>
              Disconnect
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={reject}>
              Reject
            </button>
            <button className="btn" onClick={() => void answer(prompt.promptId, 'trustOnce')}>
              Connect once
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void answer(prompt.promptId, 'trustAndSave')}
              data-autofocus
            >
              Trust and save
            </button>
          </>
        )
      }
    >
      <div className="dialog-body">
        {changed ? (
          <p className="callout callout-danger">
            The key presented by <strong>{where}</strong> is different from the one you trusted
            before. This can mean the server was reinstalled, or that someone is intercepting the
            connection. Nothing has been sent to the server.
          </p>
        ) : (
          <p>
            The authenticity of <strong>{where}</strong> cannot be established. Compare the
            fingerprint with one you got from the server&apos;s administrator.
          </p>
        )}
        <dl className="fingerprint">
          <dt>Algorithm</dt>
          <dd>{prompt.algorithm}</dd>
          {changed && (
            <>
              <dt>Saved fingerprint</dt>
              <dd className="mono">{prompt.previousFingerprint}</dd>
            </>
          )}
          <dt>{changed ? 'New fingerprint' : 'Fingerprint (SHA-256)'}</dt>
          <dd className="mono">{prompt.fingerprint}</dd>
        </dl>
      </div>
    </Dialog>
  );
}

const TITLES: Record<AuthPrompt['method'], string> = {
  password: 'Password required',
  passphrase: 'Key passphrase required',
  keyboardInteractive: 'Authentication',
};

function AuthDialog({ prompt }: { prompt: AuthPrompt }) {
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
      title={prompt.name || TITLES[prompt.method]}
      onClose={cancel}
      persistent
      footer={
        <>
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            OK
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
            That did not work. Try again.
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
