// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setBackendForTests, ipc } from '../../shared/ipc';
import type { MockNote, MockSsh } from '../../shared/mockBackend';
import { conn, lastSaved, mountApp } from '../../test/appHarness';
import { useActivity } from '../exit/activity';
import { requestExit, useExit } from '../exit/exit';
import { useLock } from '../lock/store';
import { useTabs } from '../sessions/store';
import { useProfiles } from '../terminal/profilesStore';
import { AUTOSAVE_MS, useNotes } from './store';

const A = 'a';
const B = 'b';

const note = (extra: Partial<MockNote> & Pick<MockNote, 'id' | 'title'>): MockNote => ({
  kind: 'internal',
  format: 'markdown',
  source: null,
  zoom: 100,
  connections: [A],
  text: '',
  offlineText: null,
  offlineAt: null,
  ...extra,
});

async function mount(setup?: (ssh: MockSsh) => void, options = {}) {
  useProfiles.setState({ profiles: [], defaultId: null, loaded: false, loading: false });
  useActivity.setState({ transfers: {}, unsaved: {} });
  useExit.setState({ summary: null });
  useNotes.setState({ counts: {}, overview: {}, content: {}, drafts: {}, view: 'files' });
  const mounted = mountApp({ connections: [conn(A, 'alpha'), conn(B, 'beta')] }, options);
  const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
  setup?.(ssh);
  await screen.findByRole('tree');
  await useNotes.getState().refreshCounts();
  const open = async (name: string) => {
    const before = ssh.opens.length;
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText(name));
    await waitFor(() => expect(ssh.opens.length).toBe(before + 1));
    await waitFor(() =>
      expect(useTabs.getState().tabs.every((t) => t.status === 'connected')).toBe(true),
    );
  };
  return { ...mounted, ssh, open };
}

const tab = (n: number) => screen.getAllByRole('tab')[n]!;
const panel = () => screen.queryByRole('region', { hidden: true, name: /^Notes of/ });
const notesPanel = () => screen.findByLabelText(/^Notes of alpha$|^Notes of beta$/);

async function openNotesViaTab(index = 0) {
  fireEvent.contextMenu(tab(index));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Notes & Documentation' }));
  return notesPanel();
}

const viewer = () => document.querySelector<HTMLElement>('.doc');

afterEach(() => {
  vi.useRealTimers();
  __setBackendForTests(null);
});

describe('entry points and minimalism', () => {
  it('a connection without notes shows plain SFTP: no switch, no indicator, no empty Files/Notes sections', async () => {
    const { open } = await mount();
    await open('alpha');
    expect(screen.queryByRole('group', { name: 'Panel' })).toBeNull();
    expect(screen.getByText('SFTP', { selector: '.sftp-title' })).toBeTruthy();
    expect(within(screen.getByRole('tree')).queryByLabelText(/notes?$/)).toBeNull();
    expect(panel()).toBeNull();
  });

  it('opens from the tab menu, offers to add the first note and shows nothing else', async () => {
    const { open } = await mount();
    await open('alpha');
    const p = await openNotesViaTab();
    expect(within(p).getByText('No notes for alpha yet.')).toBeTruthy();
    for (const name of [
      'New note…',
      'Attach a file…',
      'Add a web address…',
      'Attach an existing note…',
    ]) {
      expect(within(p).getByRole('button', { name })).toBeTruthy();
    }
    // the SFTP browser is still there, just not shown
    expect(screen.getByRole('group', { name: 'Panel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(await screen.findByRole('listbox', { name: 'Remote files' })).toBeTruthy();
  });

  it('a connection that has notes shows a quiet mark in the tree and a Files | Notes switch', async () => {
    const { open } = await mount((s) => s.notes.items.push(note({ id: 'n1', title: 'Commands' })));
    await open('alpha');
    expect(within(screen.getByRole('tree')).getByLabelText('1 note')).toBeTruthy();
    expect(within(screen.getByRole('tree')).queryAllByLabelText(/notes?$/)).toHaveLength(1); // not on beta
    expect(screen.getByRole('group', { name: 'Panel' })).toBeTruthy();
  });

  it('the connection menu offers Notes & Documentation and Add note… (also without a session)', async () => {
    const { ssh } = await mount();
    fireEvent.contextMenu(within(screen.getByRole('tree')).getByText('alpha'));
    expect(await screen.findByRole('menuitem', { name: 'Notes & Documentation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add note…' }));
    const prompt = await screen.findByRole('dialog');
    fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: 'Runbook' } });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(ssh.notes.items).toHaveLength(1));
    expect(ssh.opens).toHaveLength(0); // no connection was made for it
    expect(await within(screen.getByRole('tree')).findByLabelText('1 note')).toBeTruthy();
  });
});

describe('reading and writing notes', () => {
  it('shows a single note at once, without a list; several notes get a compact list', async () => {
    const { open, ssh } = await mount((s) =>
      s.notes.items.push(note({ id: 'n1', title: 'Commands', text: '# Hello\n\nWorld' })),
    );
    await open('alpha');
    const p = await openNotesViaTab();
    await waitFor(() => expect(viewer()?.textContent).toContain('World'));
    expect(within(p).queryByRole('listbox', { name: 'Documents' })).toBeNull();
    expect(within(p).getByRole('heading', { name: 'Hello' })).toBeTruthy();
    // a second note brings the list
    ssh.notes.items.push(note({ id: 'n2', title: 'Network', text: 'eth0' }));
    await act(async () => {
      await useNotes.getState().load(A);
    });
    const list = await within(p).findByRole('listbox', { name: 'Documents' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Commands', 'Network']);
  });

  it('keyboard navigation selects documents, and the last one is remembered', async () => {
    const { open, ssh } = await mount((s) => {
      s.notes.items.push(
        note({ id: 'n1', title: 'One', text: 'first' }),
        note({ id: 'n2', title: 'Two', text: 'second' }),
      );
    });
    await open('alpha');
    const p = await openNotesViaTab();
    await waitFor(() => expect(viewer()?.textContent).toContain('first'));
    const first = within(p).getByRole('option', { name: 'One' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    await waitFor(() => expect(viewer()?.textContent).toContain('second'));
    expect(ssh.notes.lastSelected[A]).toBe('n2');
    // closing and reopening the panel for this connection shows the same document again
    await act(async () => {
      useNotes.setState({ overview: {}, content: {} });
      await useNotes.getState().load(A);
    });
    await waitFor(() => expect(viewer()?.textContent).toContain('second'));
  });

  it('creates a Markdown note, edits it with autosave and previews it', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const p = await openNotesViaTab();
    fireEvent.click(within(p).getByRole('button', { name: 'New note…' }));
    const prompt = await screen.findByRole('dialog');
    fireEvent.change(within(prompt).getByRole('textbox'), {
      target: { value: 'Proxmox commands' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Create' }));
    const editor = (await screen.findByLabelText('Edit note')) as HTMLTextAreaElement;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.change(editor, { target: { value: '# Pools\n\n```bash\nvps-ip-pool list\n```' } });
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    expect(ssh.notes.writes).toEqual([]); // debounced
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 50);
    });
    vi.useRealTimers();
    await waitFor(() => expect(ssh.notes.writes).toHaveLength(1));
    expect(ssh.notes.items[0]!.text).toContain('vps-ip-pool list');
    expect(await screen.findByText('Saved on this computer')).toBeTruthy();
    fireEvent.click(within(p).getByRole('button', { name: 'Preview' }));
    expect(within(p).getByRole('heading', { name: 'Pools' })).toBeTruthy();
    expect(viewer()?.querySelector('pre code')?.textContent).toBe('vps-ip-pool list');
  });

  it('a failed save keeps the text, says so and can be retried; the exit warning counts it', async () => {
    const { open, ssh } = await mount((s) =>
      s.notes.items.push(note({ id: 'n1', title: 'Commands', text: 'old' })),
    );
    await open('alpha');
    const p = await openNotesViaTab();
    await waitFor(() => expect(viewer()?.textContent).toContain('old'));
    fireEvent.click(within(p).getByRole('button', { name: 'Edit' }));
    ssh.notes.failWrite = 'The disk is full.';
    const editor = (await screen.findByLabelText('Edit note')) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'my new text' } });
    await act(async () => {
      await useNotes.getState().flush('n1');
    });
    const alert = await screen.findByText(/Not saved: The disk is full\./);
    expect(alert).toBeTruthy();
    expect(ssh.notes.items[0]!.text).toBe('old');
    expect((screen.getByLabelText('Edit note') as HTMLTextAreaElement).value).toBe('my new text');
    // leaving the note does not throw the text away
    await act(async () => requestExit());
    expect((await screen.findByRole('dialog', { name: 'Exit PeachTerm?' })).textContent).toContain(
      'A note has changes that are not saved yet.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(p).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ssh.notes.items[0]!.text).toBe('my new text'));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    expect(useActivity.getState().unsaved.notes).toBeUndefined();
  });

  it('plain-text notes keep their whitespace and can be copied as a whole', async () => {
    const { open } = await mount((s) =>
      s.notes.items.push(
        note({ id: 'n1', title: 'Plain', format: 'text', text: 'a  b\n   c\n\td' }),
      ),
    );
    await open('alpha');
    const p = await openNotesViaTab();
    await waitFor(() =>
      expect(viewer()?.querySelector('pre')?.textContent).toBe('a  b\n   c\n\td'),
    );
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    fireEvent.click(within(p).getByRole('button', { name: 'Document actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy all' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith('a  b\n   c\n\td'));
  });
});

describe('security of what is shown', () => {
  it('Markdown with raw HTML, scripts and javascript: links renders as inert text', async () => {
    const evil = [
      '# Title',
      '',
      '<script>globalThis.__pwned = true</script>',
      '',
      '<img src=x onerror="globalThis.__pwned = true">',
      '',
      '[click me](javascript:alert(1)) and [safe](https://example.com/docs)',
    ].join('\n');
    (globalThis as Record<string, unknown>).__pwned = false;
    const { open, ssh } = await mount((s) =>
      s.notes.items.push(note({ id: 'n1', title: 'Evil', text: evil })),
    );
    await open('alpha');
    await openNotesViaTab();
    await waitFor(() => expect(viewer()?.textContent).toContain('Title'));
    const doc = viewer()!;
    expect(doc.querySelector('script, img, iframe, object, embed, form')).toBeNull();
    expect(doc.textContent).toContain('<script>globalThis.__pwned = true</script>');
    const hrefs = [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com/docs']);
    expect(doc.innerHTML).not.toMatch(/javascript:/i);
    expect((globalThis as Record<string, unknown>).__pwned).toBe(false);
    // clicking a web link goes through the validated command, never a navigation
    fireEvent.click(within(doc).getByRole('link', { name: 'safe' }));
    await waitFor(() => expect(ssh.notes.links).toEqual(['https://example.com/docs']));
  });

  it('a linked HTML guide is reduced to safe structure: no script, frame, form, handler or style', async () => {
    const html = `<html><head><style>body{display:none}</style><script>globalThis.__pwned=true</script></head>
      <body onload="globalThis.__pwned=true"><h1 id="top">Guide</h1>
      <p>Run <code>qm list</code> <button onclick="x()">Copy</button></p>
      <iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="x"></form>
      <pre>vps-create --name web1</pre><a href="#top">top</a> <a href="javascript:1">bad</a></body></html>`;
    (globalThis as Record<string, unknown>).__pwned = false;
    const { open } = await mount((s) => {
      s.notes.items.push(
        note({
          id: 'n1',
          title: 'Guide',
          kind: 'localFile',
          format: 'html',
          source: 'C:\\docs\\guide.html',
        }),
      );
      s.notes.files['C:\\docs\\guide.html'] = html;
    });
    await open('alpha');
    await openNotesViaTab();
    await waitFor(() => expect(viewer()?.textContent).toContain('qm list'));
    const doc = viewer()!;
    expect(doc.querySelector('script, iframe, form, input, button.x, style, object')).toBeNull();
    expect(doc.innerHTML).not.toMatch(/onclick|onload|javascript:|evil\.example|display:none/i);
    expect(doc.querySelector('pre')?.textContent).toBe('vps-create --name web1');
    expect((globalThis as Record<string, unknown>).__pwned).toBe(false);
  });

  it('code blocks have a Copy button that only copies: nothing is sent to any terminal', async () => {
    const { open, ssh } = await mount((s) =>
      s.notes.items.push(
        note({ id: 'n1', title: 'Danger', text: '```\nqm destroy 100 --purge\n```' }),
      ),
    );
    await open('alpha');
    await openNotesViaTab();
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    await waitFor(() => expect(viewer()?.querySelector('.doc-copy')).toBeTruthy());
    fireEvent.click(within(viewer()!).getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith('qm destroy 100 --purge'));
    expect(ssh.writes).toEqual([]);
    expect(screen.queryByRole('button', { name: /execute|run/i })).toBeNull();
  });
});

describe('linked files', () => {
  it('attaches a local file by reference and reads it; a missing file stays attached with clear options', async () => {
    const { open, ssh } = await mount((s) => {
      s.notes.files['C:\\docs\\net.md'] = '# Network\n\neth0';
      s.notes.nextFile = { path: 'C:\\docs\\net.md', format: 'markdown' };
    });
    await open('alpha');
    const p = await openNotesViaTab();
    fireEvent.click(within(p).getByRole('button', { name: 'Attach a file…' }));
    await waitFor(() => expect(viewer()?.textContent).toContain('eth0'));
    expect(within(p).queryByRole('button', { name: 'Edit' })).toBeNull(); // read-only
    expect(ssh.notes.items[0]!.text).toBe(''); // nothing was copied
    // the file disappears
    delete ssh.notes.files['C:\\docs\\net.md'];
    fireEvent.click(within(p).getByRole('button', { name: 'Document actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reload from disk' }));
    const alert = await within(p).findByRole('alert');
    expect(alert.textContent).toContain('not found');
    expect(within(alert).getByRole('button', { name: 'Locate file…' })).toBeTruthy();
    expect(ssh.notes.items).toHaveLength(1); // not removed automatically
    // relocate it
    ssh.notes.files['D:\\moved\\net.md'] = 'found again';
    ssh.notes.nextFile = { path: 'D:\\moved\\net.md', format: 'markdown' };
    fireEvent.click(within(alert).getByRole('button', { name: 'Locate file…' }));
    await waitFor(() => expect(viewer()?.textContent).toContain('found again'));
    expect(ssh.notes.items[0]!.source).toBe('D:\\moved\\net.md');
  });
});

describe('web documents', () => {
  const URL_ = 'https://raw.githubusercontent.com/o/r/main/README.md';

  async function addUrl(p: HTMLElement, address: string) {
    fireEvent.click(within(p).getByRole('button', { name: 'Add a web address…' }));
    const prompt = await screen.findByRole('dialog');
    fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: address } });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Add' }));
  }

  it('resolves a GitHub README link, fetches on open, is read-only and stores nothing', async () => {
    const { open, ssh } = await mount((s) => {
      s.notes.web[URL_] = '# Project\n\nInstall steps';
    });
    await open('alpha');
    const p = await openNotesViaTab();
    await addUrl(p, 'https://github.com/o/r/blob/main/README.md');
    await waitFor(() => expect(viewer()?.textContent).toContain('Install steps'));
    expect(ssh.notes.items[0]!.source).toBe(URL_);
    expect(ssh.notes.items[0]!.text).toBe('');
    expect(ssh.notes.items[0]!.offlineText).toBeNull();
    expect(within(p).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(p.textContent).toContain('raw.githubusercontent.com');
    expect(p.textContent).toContain('read-only');
  });

  it('refuses http addresses before asking the backend, and the backend refuses private ones', async () => {
    const { open, ssh } = await mount();
    await open('alpha');
    const p = await openNotesViaTab();
    fireEvent.click(within(p).getByRole('button', { name: 'Add a web address…' }));
    const prompt = await screen.findByRole('dialog');
    fireEvent.change(within(prompt).getByRole('textbox'), {
      target: { value: 'http://example.com/a.md' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Add' }));
    expect(await within(prompt).findByText(/starts with https/)).toBeTruthy();
    expect(ssh.notes.items).toHaveLength(0);
    fireEvent.change(within(prompt).getByRole('textbox'), {
      target: { value: 'https://192.168.1.10/a.md' },
    });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText(/local or private network/)).toBeTruthy());
    expect(ssh.notes.items).toHaveLength(0);
    expect(ssh.notes.fetches).toEqual([]);
  });

  it('offline: a clear state with Try again, then an explicit offline copy that works without network', async () => {
    const { open, ssh } = await mount((s) => {
      s.notes.items.push(note({ id: 'w1', title: 'README', kind: 'remoteUrl', source: URL_ }));
      s.notes.web[URL_] = '!The document could not be downloaded (no connection?).';
    });
    await open('alpha');
    const p = await openNotesViaTab();
    const alert = await within(p).findByRole('alert');
    expect(alert.textContent).toContain('could not be downloaded');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Open in browser' })).toBeTruthy();
    expect(ssh.notes.items[0]!.offlineText).toBeNull(); // nothing was cached behind the user's back

    // back online: read, then save an offline copy on purpose
    ssh.notes.web[URL_] = '# Docs v1';
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(viewer()?.textContent).toContain('Docs v1'));
    fireEvent.click(within(p).getByRole('button', { name: 'Document actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Save offline copy' }));
    await waitFor(() => expect(ssh.notes.items[0]!.offlineText).toBe('# Docs v1'));

    // offline again: the saved copy is shown, labelled as such
    ssh.notes.web[URL_] = '!The server did not answer in time.';
    fireEvent.click(within(p).getByRole('button', { name: 'Document actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Refresh from source' }));
    await waitFor(() => expect(p.textContent).toContain('Showing the saved offline copy'));
    expect(viewer()?.textContent).toContain('Docs v1');
    // and it can be removed again
    fireEvent.click(within(p).getByRole('button', { name: 'Document actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove offline copy' }));
    await waitFor(() => expect(ssh.notes.items[0]!.offlineText).toBeNull());
  });
});

describe('sharing between connections', () => {
  it('a shared note is one document: edits reach both, detaching keeps it, deleting asks and is global', async () => {
    const { open, ssh } = await mount((s) =>
      s.notes.items.push(
        note({ id: 'n1', title: 'VPS commands', text: 'v1', connections: [A, B] }),
      ),
    );
    await open('alpha');
    await open('beta');
    const p = await openNotesViaTab(0);
    await waitFor(() => expect(p.textContent).toContain('shared with beta'));
    // edit via alpha
    await act(async () => {
      useNotes.getState().edit('n1', 'v2');
      await useNotes.getState().flush('n1');
    });
    expect(ssh.notes.items[0]!.text).toBe('v2');
    // beta sees the same note
    fireEvent.click(tab(1));
    const pb = await screen.findByLabelText('Notes of beta');
    await waitFor(() => expect(pb.textContent).toContain('shared with alpha'));
    await waitFor(() => expect(viewer()?.textContent).toContain('v2'));
    // detach from beta only
    fireEvent.click(within(pb).getByRole('button', { name: 'Document actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Detach from this connection' }));
    await waitFor(() => expect(ssh.notes.items[0]!.connections).toEqual([A]));
    expect(ssh.notes.deleted).toEqual([]);
    // alpha still has it; deleting it everywhere needs a confirmation
    fireEvent.click(tab(0));
    const pa = await screen.findByLabelText('Notes of alpha');
    await waitFor(() => expect(viewer()?.textContent).toContain('v2'));
    fireEvent.click(within(pa).getByRole('button', { name: 'Document actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete everywhere…' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm.textContent).toContain('cannot be undone');
    expect(ssh.notes.deleted).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete everywhere' }));
    await waitFor(() => expect(ssh.notes.deleted).toEqual(['n1']));
  });

  it('an existing (also unattached) note can be attached to another connection', async () => {
    const { open, ssh } = await mount((s) =>
      s.notes.items.push(
        note({ id: 'n1', title: 'Orphan guide', text: 'kept', connections: [] }),
        note({ id: 'n2', title: 'Mine', text: 'x', connections: [A] }),
      ),
    );
    await open('alpha');
    const p = await openNotesViaTab();
    fireEvent.click(within(p).getByRole('button', { name: 'Add a note' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach an existing note…' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Orphan guide (unattached)' }));
    await waitFor(() =>
      expect(ssh.notes.items.find((n) => n.id === 'n1')!.connections).toEqual([A]),
    );
    await waitFor(() => expect(viewer()?.textContent).toContain('kept'));
  });
});

describe('zoom and search', () => {
  it('zooms the document only, in 10% steps between 50% and 200%, and remembers it', async () => {
    const { open, ssh, backend } = await mount((s) =>
      s.notes.items.push(note({ id: 'n1', title: 'Doc', text: 'hello' })),
    );
    await open('alpha');
    const p = await openNotesViaTab();
    await waitFor(() => expect(viewer()).toBeTruthy());
    const rootSize = document.documentElement.style.fontSize;
    const terminalFont = lastSaved(backend)?.appearance.terminalFontSize;
    const zoomIn = within(p).getByRole('button', { name: 'Zoom in' });
    fireEvent.click(zoomIn);
    await waitFor(() => expect(viewer()!.dataset.zoom).toBe('110'));
    expect(viewer()!.style.fontSize).toBe('14.3px');
    expect(ssh.notes.items[0]!.zoom).toBe(110);
    // the rest of the application is untouched
    expect(document.documentElement.style.fontSize).toBe(rootSize);
    expect(lastSaved(backend)?.appearance.terminalFontSize).toBe(terminalFont);
    for (let i = 0; i < 12; i++)
      fireEvent.click(within(p).getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(viewer()!.dataset.zoom).toBe('200'));
    expect((within(p).getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(within(p).getByRole('button', { name: 'Reset zoom to 100%' }));
    await waitFor(() => expect(viewer()!.dataset.zoom).toBe('100'));
    for (let i = 0; i < 8; i++)
      fireEvent.click(within(p).getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(viewer()!.dataset.zoom).toBe('50'));
    expect(
      (within(p).getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // reopened later: the saved zoom is used
    await act(async () => {
      useNotes.setState({ overview: {}, content: {} });
      await useNotes.getState().load(A);
    });
    await waitFor(() => expect(viewer()!.dataset.zoom).toBe('50'));
  });

  it('fit to width shrinks wide content to the panel and leaves content that fits alone', async () => {
    const { open } = await mount((s) =>
      s.notes.items.push(
        note({ id: 'n1', title: 'Wide', text: '| a | b |\n|---|---|\n| 1 | 2 |' }),
      ),
    );
    await open('alpha');
    const p = await openNotesViaTab();
    await waitFor(() => expect(viewer()).toBeTruthy());
    const doc = viewer()!;
    const wide = doc.querySelector('.doc-table-wrap') as HTMLElement;
    Object.defineProperty(doc, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(wide, 'scrollWidth', { value: 300, configurable: true });
    fireEvent.click(within(p).getByRole('button', { name: 'Fit to width' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(viewer()!.dataset.zoom).toBe('100'); // already fits
    Object.defineProperty(wide, 'scrollWidth', { value: 600, configurable: true });
    fireEvent.click(within(p).getByRole('button', { name: 'Fit to width' }));
    await waitFor(() => expect(viewer()!.dataset.zoom).toBe('50'));
  });

  it('searches inside the document, counts matches and moves between them', async () => {
    const { open } = await mount((s) =>
      s.notes.items.push(
        note({ id: 'n1', title: 'Doc', text: 'Alpha beta\n\nbeta gamma\n\n`beta`' }),
      ),
    );
    await open('alpha');
    const p = await openNotesViaTab();
    await waitFor(() => expect(viewer()).toBeTruthy());
    const search = within(p).getByLabelText('Search in document');
    fireEvent.change(search, { target: { value: 'BETA' } });
    await waitFor(() => expect(screen.getByTestId('search-count').textContent).toBe('1 / 3'));
    expect(document.querySelectorAll('mark.doc-hit')).toHaveLength(3);
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('search-count').textContent).toBe('2 / 3'));
    fireEvent.change(search, { target: { value: 'nothing-here' } });
    await waitFor(() => expect(screen.getByTestId('search-count').textContent).toBe('No matches'));
  });
});

describe('panel placement and tabs', () => {
  it.each(['left', 'right'] as const)(
    'lives in the SFTP dock on the %s and resizes like it',
    async (side) => {
      const { open, backend } = await mount(
        (s) => s.notes.items.push(note({ id: 'n1', title: 'Doc', text: 'x' })),
        {
          settings: (st: import('../../shared/types').Settings) => ({
            ...st,
            ui: { ...st.ui, sftpSide: side },
          }),
        },
      );
      await open('alpha');
      await openNotesViaTab();
      expect(document.querySelector('.session-body')?.getAttribute('data-side')).toBe(side);
      const aside = document.querySelector('aside.sftp-panel')!;
      expect(aside.querySelector('.notes-panel')).toBeTruthy();
      // the dock's own divider resizes it (arrow keys)
      const handle = screen.getByRole('separator', { name: 'Resize SFTP panel' });
      const before = Number(handle.getAttribute('aria-valuenow'));
      fireEvent.keyDown(handle, { key: side === 'right' ? 'ArrowLeft' : 'ArrowRight' });
      await waitFor(() => expect(lastSaved(backend)?.ui.sftpWidth).toBe(before + 16));
    },
  );

  it('collapses and reopens, and opening notes brings a collapsed panel back', async () => {
    const { open } = await mount((s) =>
      s.notes.items.push(note({ id: 'n1', title: 'Doc', text: 'x' })),
    );
    await open('alpha');
    await openNotesViaTab();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse SFTP panel' }));
    await waitFor(() => expect(screen.queryByLabelText('Notes of alpha')).toBeNull());
    fireEvent.contextMenu(tab(0));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Notes & Documentation' }));
    expect(await screen.findByLabelText('Notes of alpha')).toBeTruthy();
  });

  it('follows the selected SSH tab, shows nothing for a connection without notes, and survives Split View', async () => {
    const { open, ssh } = await mount((s) =>
      s.notes.items.push(note({ id: 'n1', title: 'Alpha notes', text: 'only on alpha' })),
    );
    await open('alpha');
    await open('beta');
    await openNotesViaTab(0);
    await waitFor(() => expect(viewer()?.textContent).toContain('only on alpha'));
    fireEvent.click(tab(1));
    const pb = await screen.findByLabelText('Notes of beta');
    expect(within(pb).getByText('No notes for beta yet.')).toBeTruthy();
    expect(viewer()).toBeNull();
    fireEvent.click(tab(0));
    await waitFor(() => expect(viewer()?.textContent).toContain('only on alpha'));
    // moving a tab into a split pane changes nothing about the notes or the sessions
    const opens = ssh.opens.length;
    const [a] = useTabs.getState().tabs;
    expect(useTabs.getState().dropTab(a!.id, 'single', 'right')).toBe('ok');
    await waitFor(() => expect(screen.queryByLabelText(/^Notes of/)).toBeTruthy());
    expect(ssh.opens).toHaveLength(opens);
    expect(ssh.closes).toEqual([]);
  });
});

describe('Application Lock', () => {
  it('refuses every note command while locked, and forgets fetched content', async () => {
    const mounted = mountApp(
      { connections: [conn(A, 'alpha')] },
      { lockPassword: 'correct horse', lockEnabled: true },
    );
    const ssh = (mounted.backend as unknown as { ssh: MockSsh }).ssh;
    ssh.notes.items.push(note({ id: 'n1', title: 'Secret runbook', text: 'TOP-SECRET-STEPS' }));
    useNotes.setState({ counts: {}, overview: {}, content: {}, drafts: {}, view: 'files' });
    await screen.findByRole('tree');
    fireEvent.doubleClick(within(screen.getByRole('tree')).getByText('alpha'));
    await waitFor(() => expect(useTabs.getState().tabs[0]?.status).toBe('connected'));
    await openNotesViaTab();
    await waitFor(() => expect(viewer()?.textContent).toContain('TOP-SECRET-STEPS'));
    fireEvent.click(await screen.findByRole('button', { name: 'Lock PeachTerm' }));
    await waitFor(() => expect(useLock.getState().view?.locked).toBe(true));
    expect(Object.keys(useNotes.getState().content)).toEqual([]);
    expect(JSON.stringify(useNotes.getState())).not.toContain('TOP-SECRET-STEPS');
    for (const call of [
      () => ipc.notesList(A),
      () => ipc.notesCounts(),
      () => ipc.notesAll(),
      () => ipc.noteRead('n1'),
      () => ipc.noteWrite('n1', 'x'),
      () => ipc.noteSaveOffline('n1'),
      () => ipc.noteAttachUrl(A, 'https://example.com/a.md'),
      () => ipc.noteAttachFile(A),
      () => ipc.noteDelete('n1'),
      () => ipc.noteOpenLink('https://example.com'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'locked' });
    }
  });
});

describe('settings pages stay put', () => {
  beforeEach(() => undefined);
  it('the Notes feature adds no new top-level navigation to Settings or the window', async () => {
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const pages = within(dialog)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(pages.join('|')).not.toMatch(/Notes|Documentation/);
  });
});
