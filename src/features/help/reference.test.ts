// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { applicable, safeForCommand, suggestedCommands, verdicts } from './permissions';
import { COMMANDS, explain, flagKey } from './reference';
import type { PermissionReport } from '../../shared/types';

const ok = (text: string) => {
  const r = explain(text);
  if (!r.ok) throw new Error(`expected an explanation for: ${text}`);
  return r.explanation;
};

describe('Linux help is off by default', () => {
  it('ships disabled, with both sub-options preselected', () => {
    expect(DEFAULT_SETTINGS.linuxHelp).toEqual({
      enabled: false,
      explain: true,
      permissions: true,
    });
  });
});

describe('explaining selected text', () => {
  it('knows the curated commands and their flags', () => {
    expect(ok('pwd').def.id).toBe('pwd');
    const ls = ok('ls -la /var/log');
    expect(ls.def.id).toBe('ls');
    expect(ls.options.map((o) => o.flag)).toEqual(expect.arrayContaining(['-l', '-a']));
    expect(ls.hasArguments).toBe(true);
    expect(ok('df -h').def.id).toBe('df');
    expect(ok('docker ps').def.id).toBe('docker_ps');
    expect(ok('systemctl status nginx').def.id).toBe('systemctl_status');
  });

  it('lists options it does not know instead of guessing', () => {
    const r = ok('ls --nonsense');
    expect(r.unknown).toContain('--nonsense');
  });

  it.each([
    'rm -rf /',
    'chmod 777 /etc',
    'sudo ls',
    'ls | grep x',
    'ls; reboot',
    'cat a > b',
    'echo $(whoami)',
    'ls `id`',
    'find / -exec rm {} ;',
    'find . -delete',
    'cat ~/.ssh/id_rsa && ls',
    'ls\nrm x',
    'unknowncmd',
    '',
    '   ',
    'ls ' + 'a'.repeat(300),
  ])('refuses %j', (text) => {
    expect(explain(text).ok).toBe(false);
  });

  it('does not accept commands that can modify the system', () => {
    expect(
      explain('date -s 2020-01-01').ok === false ||
        !ok('date -s 2020-01-01').options.some((o) => o.flag === '-s'),
    ).toBe(true);
    expect(explain('hostname newname').ok).toBe(false);
  });
});

describe('the reference table', () => {
  const forbidden = /\b(rm|chmod|chown|sudo|su|kill|reboot|shutdown|mkfs|dd|restart|stop|mv|cp)\b/;
  it('has no destructive example, no shell syntax and every example is explainable', () => {
    for (const c of COMMANDS) {
      expect(c.examples.length).toBeGreaterThan(0);
      for (const example of c.examples) {
        expect(example).not.toMatch(forbidden);
        expect(example).not.toMatch(/[|;&<>`$]/);
        expect(explain(example).ok, example).toBe(true);
      }
    }
  });

  it('has a translation for every command, flag and caveat in every language', () => {
    const langs = ['en', 'ru', 'de', 'fr', 'es', 'sr-Latn'];
    for (const lang of langs) {
      const json = JSON.parse(readFileSync(`src/i18n/locales/${lang}.json`, 'utf8'));
      const cmd = json.help.cmd;
      for (const c of COMMANDS) {
        expect(cmd[c.id]?.summary, `${lang} ${c.id}`).toBeTruthy();
        if (c.caveat) expect(cmd[c.id].caveat, `${lang} ${c.id} caveat`).toBeTruthy();
        for (const f of c.flags)
          expect(cmd[c.id].flag?.[flagKey(f.flag)], `${lang} ${c.id} ${f.flag}`).toBeTruthy();
      }
    }
  });

  it('marks the commands that can be expensive or sensitive', () => {
    for (const id of ['du', 'find', 'cat', 'journalctl', 'docker_inspect']) {
      expect(COMMANDS.find((c) => c.id === id)?.caveat, id).toBe(true);
    }
  });
});

const report = (over: Partial<PermissionReport> = {}): PermissionReport => ({
  platform: 'linux',
  exec: 'ok',
  user: { uid: 1000, gid: 1000, name: 'deploy', groups: [{ gid: 33, name: 'www-data' }] },
  path: '/var/www',
  pathRefused: false,
  target: { mode: 'drwxr-xr-x', owner: 'root', group: 'root', name: '/var/www' },
  chain: [],
  access: { write: false, search: true },
  unsupported: [],
  ...over,
});

describe('permission verdicts', () => {
  it('reads owner, group and other bits for the right class', () => {
    expect(applicable(report())).toEqual([true, false, true]);
    expect(
      applicable(
        report({ target: { mode: 'drwxrwxr-x', owner: 'root', group: 'www-data', name: 'x' } }),
      ),
    ).toEqual([true, true, true]);
    expect(
      applicable(
        report({ target: { mode: 'drwx------', owner: 'deploy', group: 'x', name: 'x' } }),
      ),
    ).toEqual([true, true, true]);
  });

  it('explains a missing write bit cautiously', () => {
    expect(verdicts(report()).map((v) => v.key)).toEqual(['help.perm.vNoWrite']);
  });

  it('mentions ACLs and never claims certainty when nothing is clear', () => {
    const acl = report({
      target: { mode: 'drwxr-xr-x+', owner: 'root', group: 'root', name: 'x' },
    });
    expect(verdicts(acl).map((v) => v.key)).toContain('help.perm.vAcl');
    expect(verdicts(report({ target: null, user: null })).map((v) => v.key)).toEqual([
      'help.perm.vUnknown',
    ]);
  });

  it('says a read-only file system is possible when bits allow but the shell test fails', () => {
    const r = report({
      target: { mode: 'drwxrwxrwx', owner: 'root', group: 'root', name: 'x' },
      access: { write: false, search: true },
    });
    expect(verdicts(r).map((v) => v.key)).toContain('help.perm.vReadOnly');
  });
});

describe('suggested commands', () => {
  it('only offers read-only commands, quoted, and never for unsafe paths', () => {
    expect(suggestedCommands('/var/www')).toEqual([
      'id',
      "ls -ld -- '/var/www'",
      "namei -l -- '/var/www'",
    ]);
    for (const bad of ["/tmp/a'b", '/tmp/a!b', 'relative', '/tmp/a\nb', '/' + 'a'.repeat(1100)]) {
      expect(safeForCommand(bad)).toBe(false);
      expect(suggestedCommands(bad)).toEqual(['id']);
    }
  });
});
