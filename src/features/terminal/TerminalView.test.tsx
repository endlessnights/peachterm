// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { __emitSshPromptForTests } from '../../shared/ipc';
import { conn, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { useTabs } from '../sessions/store';

const seed = { connections: [conn('a', 'alpha')] };

async function openSession() {
  const mounted = mountApp(seed);
  const ssh = (mounted.backend as unknown as { ssh: import('../../shared/mockBackend').MockSsh })
    .ssh;
  await screen.findByText('alpha');
  fireEvent.doubleClick(screen.getByText('alpha'));
  await waitFor(() => expect(ssh.opens).toHaveLength(1));
  await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
  return { ...mounted, ssh };
}

describe('terminal session', () => {
  it('opens exactly one backend session per tab and shows its output', async () => {
    const { ssh } = await openSession();
    expect(ssh.opens[0]).toMatchObject({ connectionId: 'a', cols: 80, rows: 24, attempt: 0 });
    const term = fakeTerminals[0]!;
    await waitFor(() => expect(term.written.join('')).toContain('mock shell ready'));
    // the tab knows its backend session
    expect(useTabs.getState().tabs[0]?.sessionId).toBe(ssh.opens[0]!.sessionId);
  });

  it('acknowledges rendered output so the backend can keep sending', async () => {
    const { ssh } = await openSession();
    await waitFor(() => expect(ssh.acks.length).toBeGreaterThan(0));
    const total = ssh.acks.reduce((n, a) => n + a.bytes, 0);
    expect(total).toBe('mock shell ready\r\n'.length);
    expect(ssh.acks[0]!.sessionId).toBe(ssh.opens[0]!.sessionId);
  });

  it('sends keystrokes as UTF-8 and reports resizes', async () => {
    const { ssh } = await openSession();
    const term = fakeTerminals[0]!;
    act(() => term.type('ls é\r'));
    await waitFor(() => expect(ssh.writes).toHaveLength(1));
    // The mock decodes base64 to a binary string: é is two UTF-8 bytes.
    expect(ssh.writes[0]!.text).toBe('ls Ã©\r');
    act(() => term.resize(120, 40));
    await waitFor(() =>
      expect(ssh.resizes).toEqual([expect.objectContaining({ cols: 120, rows: 40 })]),
    );
  });

  it('shows a reconnect button when the server closes, and reconnecting makes a NEW session', async () => {
    const { ssh } = await openSession();
    const first = ssh.opens[0]!.sessionId;
    act(() => {
      ssh.emit(first, { kind: 'status', state: 'failed' });
      ssh.emit(first, { kind: 'closed', reason: 'auth_failed' });
    });
    expect(await screen.findByText('Authentication failed.')).toBeTruthy();
    expect(useTabs.getState().tabs[0]?.status).toBe('failed');
    fireEvent.click(screen.getByRole('button', { name: /Reconnect/ }));
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
    expect(ssh.opens[1]!.sessionId).not.toBe(first);
    expect(ssh.opens[1]!.attempt).toBe(1);
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
  });

  it('closing the tab ends the backend session', async () => {
    const { ssh } = await openSession();
    const id = ssh.opens[0]!.sessionId;
    act(() => useTabs.getState().closeTab(useTabs.getState().tabs[0]!.id));
    await waitFor(() => expect(ssh.closes).toContain(id));
  });

  it('keeps two tabs independent', async () => {
    const { ssh } = await openSession();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(ssh.opens).toHaveLength(2));
    expect(ssh.opens[0]!.sessionId).not.toBe(ssh.opens[1]!.sessionId);
    act(() => fakeTerminals[1]!.type('x'));
    await waitFor(() => expect(ssh.writes).toHaveLength(1));
    expect(ssh.writes[0]!.sessionId).toBe(ssh.opens[1]!.sessionId);
  });
});

const hostKey = (extra: Record<string, unknown> = {}) =>
  ({
    kind: 'hostKey',
    promptId: 'p1',
    sessionId: 's1',
    host: 'srv.example.com',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:abc',
    previousFingerprint: null,
    ...extra,
  }) as const;

describe('SSH questions', () => {
  it('asks about an unknown host key and sends the chosen answer to Rust', async () => {
    const { ssh } = await openSession();
    act(() => __emitSshPromptForTests(hostKey()));
    expect(await screen.findByText('Unknown host')).toBeTruthy();
    expect(screen.getByText('SHA256:abc')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Trust and save' }));
    await waitFor(() =>
      expect(ssh.hostKeyAnswers).toEqual([{ promptId: 'p1', decision: 'trustAndSave' }]),
    );
    expect(screen.queryByText('Unknown host')).toBeNull();
  });

  it('treats a changed key as a warning whose safe default is to disconnect', async () => {
    const { ssh } = await openSession();
    act(() =>
      __emitSshPromptForTests(hostKey({ promptId: 'p2', previousFingerprint: 'SHA256:old' })),
    );
    expect(await screen.findByText('Host key has changed')).toBeTruthy();
    expect(screen.getByText('SHA256:old')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Trust and save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(ssh.hostKeyAnswers).toEqual([{ promptId: 'p2', decision: 'reject' }]),
    );
  });

  it('collects a password with a masked field and clears it after answering', async () => {
    const { ssh } = await openSession();
    act(() =>
      __emitSshPromptForTests({
        kind: 'auth',
        promptId: 'p3',
        sessionId: 's1',
        method: 'password',
        name: '',
        instructions: '',
        prompts: [{ text: 'Password', echo: false }],
        retry: true,
      }),
    );
    const input = (await screen.findByLabelText('Password')) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(screen.getByRole('alert').textContent).toContain('Try again');
    fireEvent.change(input, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(ssh.authAnswers).toEqual([{ promptId: 'p3', answers: ['hunter2'] }]),
    );
    expect(input.value).toBe('');
  });

  it('cancelling a credential question answers null', async () => {
    const { ssh } = await openSession();
    act(() =>
      __emitSshPromptForTests({
        kind: 'auth',
        promptId: 'p4',
        sessionId: 's1',
        method: 'keyboardInteractive',
        name: 'Verification',
        instructions: 'Enter the code',
        prompts: [{ text: 'Code', echo: true }],
        retry: false,
      }),
    );
    expect(await screen.findByText('Enter the code')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.authAnswers).toEqual([{ promptId: 'p4', answers: null }]));
  });
});
