import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetAppliedScale } from '../../app/useInterfaceScale';
import type { MockOptions, MockSsh } from '../../shared/mockBackend';
import { effectiveFontSize } from '../../shared/scale';
import { INTERFACE_SCALES } from '../../shared/types';
import { conn, lastSaved, mountApp } from '../../test/appHarness';
import { fakeTerminals } from '../../test/setup';
import { useTabs } from '../sessions/store';

beforeEach(() => __resetAppliedScale());

async function mount(options: MockOptions = {}) {
  const mounted = mountApp({ connections: [conn('a', 'alpha')] }, options);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  await screen.findByRole('tree');
  return { ...mounted, ssh };
}

async function openAppearance() {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Appearance' }));
  return dialog;
}
const slider = (dialog: HTMLElement) =>
  within(dialog).getByRole('slider', { name: 'Interface scale' }) as HTMLInputElement;
const setScale = (dialog: HTMLElement, value: number) =>
  fireEvent.change(slider(dialog), { target: { value: String(value) } });

describe('interface scale control', () => {
  it('offers 70 % to 150 % in steps of 10 and starts at 100 %', async () => {
    await mount();
    const dialog = await openAppearance();
    const range = slider(dialog);
    expect([range.min, range.max, range.step, range.value]).toEqual(['70', '150', '10', '100']);
    expect(within(dialog).getByText('100%')).toBeTruthy();
    expect(INTERFACE_SCALES).toEqual([70, 80, 90, 100, 110, 120, 130, 140, 150]);
  });

  it.each(INTERFACE_SCALES)('%i % is previewed, applied and saved', async (scale) => {
    // start from a different value so that choosing `scale` is a real change
    const from = scale === 100 ? 110 : 100;
    const { ssh, backend } = await mount({
      settings: (d) => ({ ...d, appearance: { ...d.appearance, interfaceScale: from } }),
    });
    const dialog = await openAppearance();
    setScale(dialog, scale);
    expect(within(dialog).getByText(`${scale}%`)).toBeTruthy();
    // preview: the window zoom changes while Settings is still open
    await waitFor(() => expect(ssh.scales.at(-1)).toBe(scale));
    // Apply saves without closing
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastSaved(backend)?.appearance.interfaceScale).toBe(scale));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(ssh.scales.at(-1)).toBe(scale);
  });

  it('OK saves and closes; the scale stays', async () => {
    const { ssh, backend } = await mount();
    const dialog = await openAppearance();
    setScale(dialog, 130);
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(lastSaved(backend)?.appearance.interfaceScale).toBe(130);
    expect(ssh.scales.at(-1)).toBe(130);
  });

  it('Cancel puts the previously applied scale back', async () => {
    const { ssh, backend } = await mount({
      settings: (s) => ({ ...s, appearance: { ...s.appearance, interfaceScale: 90 } }),
    });
    await waitFor(() => expect(ssh.scales.at(-1)).toBe(90)); // applied at start-up
    const dialog = await openAppearance();
    setScale(dialog, 150);
    await waitFor(() => expect(ssh.scales.at(-1)).toBe(150));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.scales.at(-1)).toBe(90));
    expect(lastSaved(backend)).toBeUndefined(); // nothing was saved
  });

  it('Reset to 100% returns to the default and is disabled there', async () => {
    const { ssh } = await mount({
      settings: (s) => ({ ...s, appearance: { ...s.appearance, interfaceScale: 120 } }),
    });
    const dialog = await openAppearance();
    const reset = within(dialog).getByRole('button', { name: 'Reset to 100%' });
    expect(reset).toHaveProperty('disabled', false);
    fireEvent.click(reset);
    expect(slider(dialog).value).toBe('100');
    await waitFor(() => expect(ssh.scales.at(-1)).toBe(100));
    expect(within(dialog).getByRole('button', { name: 'Reset to 100%' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('the saved scale is applied when the application starts', async () => {
    const { ssh } = await mount({
      settings: (s) => ({ ...s, appearance: { ...s.appearance, interfaceScale: 130 } }),
    });
    await waitFor(() => expect(ssh.scales).toEqual([130]));
  });

  it('is usable from the keyboard', async () => {
    const { ssh } = await mount();
    const dialog = await openAppearance();
    slider(dialog).focus();
    expect(document.activeElement).toBe(slider(dialog));
    expect(slider(dialog).getAttribute('aria-valuetext')).toBe('100%');
    setScale(dialog, 110);
    expect(slider(dialog).getAttribute('aria-valuetext')).toBe('110%');
    await waitFor(() => expect(ssh.scales.at(-1)).toBe(110));
  });
});

describe('terminals and the interface scale', () => {
  it('the configured terminal font is not multiplied by the scale', () => {
    expect(effectiveFontSize({ terminalFontSize: 14, interfaceScale: 100 })).toBe(14);
    // the zoom makes 1 CSS px = 1.5 screen px, so the CSS size shrinks to keep 14 on screen
    expect(effectiveFontSize({ terminalFontSize: 14, interfaceScale: 150 })).toBeCloseTo(9.333, 2);
    expect(effectiveFontSize({ terminalFontSize: 14, interfaceScale: 70 })).toBeCloseTo(20, 5);
    for (const scale of INTERFACE_SCALES) {
      const css = effectiveFontSize({ terminalFontSize: 16, interfaceScale: scale });
      expect(css * (scale / 100)).toBeCloseTo(16, 8); // on-screen size is always the setting
    }
  });

  it('terminals follow the setting, and scale changes do not touch the font setting', async () => {
    const { backend } = await mount();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(fakeTerminals).toHaveLength(1));
    expect(fakeTerminals[0]!.options.fontSize).toBe(14);
    const dialog = await openAppearance();
    setScale(dialog, 150);
    await waitFor(() =>
      expect(fakeTerminals[0]!.options.fontSize as number).toBeCloseTo(14 / 1.5, 5),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(lastSaved(backend)?.appearance.terminalFontSize).toBe(14));
    // changing the terminal font size is independent of the scale
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const again = await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.click(within(again).getByRole('button', { name: 'Appearance' }));
    fireEvent.change(within(again).getByLabelText('Font size'), { target: { value: '18' } });
    await waitFor(() =>
      expect(fakeTerminals[0]!.options.fontSize as number).toBeCloseTo(18 / 1.5, 5),
    );
  });

  it('a terminal that changes size reports it to its own session (the PTY follows the viewport)', async () => {
    const { ssh } = await mount();
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(useTabs.getState().tabs[0]?.sessionId).not.toBeNull());
    // after a zoom the terminal gets fewer/more cells: xterm reports it
    act(() => fakeTerminals[0]!.resize(53, 16));
    await waitFor(() =>
      expect(ssh.resizes).toEqual([expect.objectContaining({ cols: 53, rows: 16 })]),
    );
  });
});

describe('layout safety at every scale (static checks of the stylesheet)', () => {
  const css = readFileSync('src/styles/overlays.css', 'utf8');
  it('dialogs fit the viewport and scroll inside, so buttons stay reachable at 70 % and 150 %', () => {
    const dialog = /\.dialog\s*\{[^}]*\}/s.exec(css)?.[0] ?? '';
    expect(dialog).toMatch(/max-height:\s*calc\(100(d)?vh/);
    expect(dialog).toMatch(/width:\s*min\(/);
    expect(css).toMatch(/\.dialog-body[^{]*\{[^}]*overflow/s);
  });
  it('the scale is a WebView zoom, never a CSS transform', () => {
    for (const file of ['base.css', 'layout.css', 'overlays.css', 'sftp.css', 'theme.css']) {
      const text = readFileSync(`src/styles/${file}`, 'utf8');
      expect(text, file).not.toMatch(/transform:\s*scale\(/);
      expect(text, file).not.toMatch(/\bzoom\s*:/);
    }
  });
});
