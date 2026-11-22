import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { useDialogs, openSettings } from '../../app/dialogs';
import { useToasts } from '../../components/Toasts';
import { __setBackendForTests } from '../../shared/ipc';
import { createMockBackend, type MockOptions } from '../../shared/mockBackend';
import { useConnections } from '../connections/store';
import { useTabs } from '../sessions/store';
import { useSettings } from './store';

const mount = (options: MockOptions = {}) => {
  __setBackendForTests(createMockBackend(undefined, options));
  useTabs.setState({ tabs: [], activeId: null });
  useConnections.setState({ query: '', loaded: false, selectedId: null });
  useSettings.setState({ loaded: false });
  useDialogs.setState({ dialog: null });
  useToasts.setState({ toasts: [] });
  return render(<App />);
};

const openDiagnostics = async () => {
  await screen.findByRole('tree');
  openSettings();
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByText('Diagnostics'));
  return dialog;
};

afterEach(() => __setBackendForTests(null));

describe('Settings → Diagnostics', () => {
  it('shows defaults: logging on, Info level, 14 days', async () => {
    mount();
    const dialog = await openDiagnostics();
    expect(within(dialog).getByLabelText(/Write diagnostic logs/)).toHaveProperty('checked', true);
    const pressed = (name: string) =>
      within(dialog).getByRole('button', { name }).getAttribute('aria-pressed');
    expect(pressed('Info')).toBe('true');
    expect(pressed('Debug')).toBe('false');
    expect(pressed('14 days')).toBe('true');
    await within(dialog).findByText(/Logging is active at level/);
  });

  it('persists level, retention, directory and the on/off switch through Save', async () => {
    mount();
    const dialog = await openDiagnostics();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Debug' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '30 days' }));
    fireEvent.change(within(dialog).getByLabelText('Log folder'), {
      target: { value: '/var/log/peachterm-test' },
    });
    fireEvent.click(within(dialog).getByLabelText(/Write diagnostic logs/));
    fireEvent.click(within(dialog).getByText('Save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const { diagnostics } = useSettings.getState().settings;
    expect(diagnostics).toMatchObject({
      level: 'debug',
      retentionDays: 30,
      logDir: '/var/log/peachterm-test',
      fileLogging: false,
    });
  });

  it('applies logging changes immediately and refreshes the status', async () => {
    mount();
    const dialog = await openDiagnostics();
    fireEvent.click(within(dialog).getByLabelText(/Write diagnostic logs/));
    fireEvent.click(within(dialog).getByText('Apply logging settings'));
    await within(dialog).findByText('File logging is off.');
    expect(useSettings.getState().settings.diagnostics.fileLogging).toBe(false);
  });

  it('warns without blocking when the log folder is unusable', async () => {
    mount({ loggingError: 'permission_denied' });
    const dialog = await openDiagnostics();
    await within(dialog).findByText(/File logging is unavailable \(permission denied\)/);
    // The toast shown at start-up is non-blocking and the app stays usable.
    await waitFor(() =>
      expect(
        useToasts.getState().toasts.some((t) => /File logging is unavailable/.test(t.text)),
      ).toBe(true),
    );
    expect(screen.getByRole('tree')).toBeTruthy();
  });

  it('walks through the export review before saving anything', async () => {
    mount();
    const dialog = await openDiagnostics();
    fireEvent.click(within(dialog).getByText(/Export diagnostic logs/));
    const review = await within(dialog).findByRole('region', { name: 'Export review' });
    expect(within(review).getByText('peachterm-2026-11-22.log')).toBeTruthy();
    expect(
      within(review).getByText(/Not included: settings, connections, saved passwords/),
    ).toBeTruthy();
    fireEvent.click(within(review).getByText('Choose location and export'));
    await within(dialog).findByText('Archive saved');
    expect(within(dialog).getByText('Show in folder')).toBeTruthy();
  });

  it('reports recoverable start-up problems as notices', async () => {
    mount({
      issues: ['settings.json has an invalid value for "ssh.keepaliveSecs"; its default was used.'],
    });
    await screen.findByRole('tree');
    await waitFor(() =>
      expect(
        useToasts.getState().toasts.some((t) => /settings\.json has an invalid value/.test(t.text)),
      ).toBe(true),
    );
  });
});
