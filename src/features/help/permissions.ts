// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import type { PermissionReport } from '../../shared/types';

export type PermissionOperation = 'createFolder' | 'createFile' | 'rename' | 'delete' | 'upload';

export interface Verdict {
  key:
    | 'help.perm.vNoWrite'
    | 'help.perm.vNoSearch'
    | 'help.perm.vBitsAllow'
    | 'help.perm.vReadOnly'
    | 'help.perm.vAcl'
    | 'help.perm.vRoot'
    | 'help.perm.vUnknown';
  params?: Record<string, string>;
}

/** The permission bits that apply to `user` for a directory: [read, write, execute]. */
export function applicable(report: PermissionReport): [boolean, boolean, boolean] | null {
  const { user, target } = report;
  if (!user || !target || target.mode.length < 10) return null;
  const bits = (offset: number): [boolean, boolean, boolean] => [
    target.mode[offset] === 'r',
    target.mode[offset + 1] === 'w',
    // x, s, t all mean the execute bit is set in some form (lowercase)
    /[xst]/.test(target.mode[offset + 2] ?? ''),
  ];
  if (user.uid === 0) return [true, true, true];
  if (target.owner === user.name) return bits(1);
  if (user.groups.some((g) => g.name === target.group)) return bits(4);
  return bits(7);
}

/**
 * Cautious, deterministic reading of a report. It never says a write will
 * definitely succeed or fail: mode bits are not the whole story (ACLs, mounts,
 * SFTP restrictions, MAC policies), and the wording says so.
 */
export function verdicts(report: PermissionReport): Verdict[] {
  const out: Verdict[] = [];
  const bits = applicable(report);
  const { target, access, user } = report;
  if (user?.uid === 0) out.push({ key: 'help.perm.vRoot' });
  if (target && bits && user?.uid !== 0) {
    const [, write, search] = bits;
    if (!search) {
      out.push({ key: 'help.perm.vNoSearch' });
    } else if (!write) {
      out.push({
        key: 'help.perm.vNoWrite',
        params: { owner: target.owner, group: target.group, mode: target.mode },
      });
    }
  }
  if (target?.mode.endsWith('+')) out.push({ key: 'help.perm.vAcl' });
  if (access && bits && !out.some((v) => v.key === 'help.perm.vNoWrite')) {
    if (access.write && bits[1] && bits[2]) out.push({ key: 'help.perm.vBitsAllow' });
    else if (!access.write && bits[1] && bits[2]) out.push({ key: 'help.perm.vReadOnly' });
  }
  if (out.length === 0) out.push({ key: 'help.perm.vUnknown' });
  return out;
}

/** Same rule as the backend's `safe_path`: only such a path may be shown inside a command to copy. */
export function safeForCommand(path: string): boolean {
  return (
    path.startsWith('/') &&
    path.length <= 1024 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f'!]/.test(path)
  );
}

/** Read-only commands the user may copy and run themselves. Never executed by PeachTerm. */
export function suggestedCommands(dir: string): string[] {
  const list = ['id'];
  if (safeForCommand(dir)) {
    list.push(`ls -ld -- '${dir}'`, `namei -l -- '${dir}'`);
  }
  return list;
}
