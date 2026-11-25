// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Built-in, offline reference of common read-only Linux commands and the
// explainer for selected terminal text.
//
// This is reference material, not an executor and not a safety classifier.
// Being listed does not make every option or argument harmless, and nothing
// here ever runs, pastes or sends a command. Selected text is only *read*: it is
// split into words and compared with this table. Anything with shell syntax
// (pipes, redirects, expansions, quotes, command substitution, variables) is
// refused instead of being interpreted.

export type ValueKind = 'number' | 'word' | 'time';

export interface CommandDef {
  /** Key in the translations: help.cmd.<id>.* */
  id: string;
  /** What the user types, e.g. ['docker', 'ps']. */
  words: string[];
  /** Other spellings of the same command (ip a, ip address). */
  aliases?: string[][];
  /** Options this reference explains. A value after the option is checked by `ValueKind`. */
  flags: { flag: string; value?: ValueKind }[];
  /** Positional arguments: none, a path / name / unit, or free text such as a pattern. */
  positional: 'none' | 'path' | 'name' | 'text' | 'format';
  /** Literal positional words that mean something (ps aux). */
  literals?: string[];
  /** The id has a "good to know" paragraph (cost or sensitive output). */
  caveat?: boolean;
  /** Reviewed, read-only examples to copy. They are never run for you. */
  examples: string[];
  /** Subcommand words after which the rest is the target (docker logs NAME). */
  sub?: boolean;
}

const F = (flag: string, value?: ValueKind) => ({ flag, value });

export const COMMANDS: CommandDef[] = [
  { id: 'pwd', words: ['pwd'], flags: [F('-P')], positional: 'none', examples: ['pwd'] },
  {
    id: 'ls',
    words: ['ls'],
    flags: [F('-l'), F('-a'), F('-h'), F('-t'), F('-r')],
    positional: 'path',
    examples: ['ls', 'ls -l', 'ls -la', 'ls -lah'],
  },
  { id: 'whoami', words: ['whoami'], flags: [], positional: 'none', examples: ['whoami'] },
  {
    id: 'id',
    words: ['id'],
    flags: [F('-u'), F('-g'), F('-G'), F('-n')],
    positional: 'name',
    examples: ['id', 'id -Gn'],
  },
  { id: 'groups', words: ['groups'], flags: [], positional: 'name', examples: ['groups'] },
  {
    id: 'hostname',
    words: ['hostname'],
    flags: [F('-f')],
    positional: 'none',
    examples: ['hostname'],
  },
  {
    id: 'uname',
    words: ['uname'],
    flags: [F('-a'), F('-r'), F('-m'), F('-s')],
    positional: 'none',
    examples: ['uname -a', 'uname -r'],
  },
  {
    id: 'uptime',
    words: ['uptime'],
    flags: [F('-p'), F('-s')],
    positional: 'none',
    examples: ['uptime', 'uptime -p'],
  },
  {
    id: 'date',
    words: ['date'],
    flags: [F('-u'), F('-I')],
    positional: 'format',
    examples: ['date', 'date -u', 'date -I'],
  },
  {
    id: 'df',
    words: ['df'],
    flags: [F('-h'), F('-T'), F('-i')],
    positional: 'path',
    examples: ['df -h', 'df -hT'],
  },
  {
    id: 'du',
    words: ['du'],
    flags: [F('-s'), F('-h'), F('-d', 'number')],
    positional: 'path',
    caveat: true,
    examples: ['du -sh .', 'du -h -d 1 .'],
  },
  {
    id: 'free',
    words: ['free'],
    flags: [F('-h'), F('-m')],
    positional: 'none',
    examples: ['free -h'],
  },
  {
    id: 'cat',
    words: ['cat'],
    flags: [F('-n')],
    positional: 'path',
    caveat: true,
    examples: ['cat /etc/os-release'],
  },
  {
    id: 'head',
    words: ['head'],
    flags: [F('-n', 'number')],
    positional: 'path',
    examples: ['head -n 20 /etc/hosts'],
  },
  {
    id: 'tail',
    words: ['tail'],
    flags: [F('-n', 'number'), F('-f')],
    positional: 'path',
    examples: ['tail -n 50 /var/log/syslog'],
  },
  {
    id: 'wc',
    words: ['wc'],
    flags: [F('-l'), F('-w'), F('-c')],
    positional: 'path',
    examples: ['wc -l /etc/hosts'],
  },
  {
    id: 'grep',
    words: ['grep'],
    flags: [F('-i'), F('-n'), F('-r'), F('-v'), F('-c')],
    positional: 'text',
    caveat: true,
    examples: ['grep -in error /var/log/syslog'],
  },
  {
    id: 'find',
    words: ['find'],
    flags: [
      F('-name', 'word'),
      F('-type', 'word'),
      F('-maxdepth', 'number'),
      F('-mtime', 'number'),
    ],
    positional: 'path',
    caveat: true,
    examples: ['find . -maxdepth 1 -type f', 'find /var/log -maxdepth 2 -type f -mtime -1'],
  },
  { id: 'stat', words: ['stat'], flags: [], positional: 'path', examples: ['stat /etc/hostname'] },
  { id: 'file', words: ['file'], flags: [F('-b')], positional: 'path', examples: ['file /bin/ls'] },
  {
    id: 'readlink',
    words: ['readlink'],
    flags: [F('-f')],
    positional: 'path',
    examples: ['readlink -f /usr/bin/python3'],
  },
  { id: 'realpath', words: ['realpath'], flags: [], positional: 'path', examples: ['realpath .'] },
  {
    id: 'namei',
    words: ['namei'],
    flags: [F('-l')],
    positional: 'path',
    examples: ['namei -l /var/www'],
  },
  {
    id: 'ps',
    words: ['ps'],
    flags: [F('-e'), F('-f')],
    positional: 'none',
    literals: ['aux'],
    caveat: true,
    examples: ['ps aux', 'ps -ef'],
  },
  {
    id: 'ip_addr',
    words: ['ip', 'addr'],
    aliases: [
      ['ip', 'a'],
      ['ip', 'address'],
    ],
    flags: [F('-br'), F('-4'), F('-6')],
    positional: 'none',
    sub: true,
    examples: ['ip addr', 'ip -br addr'],
  },
  {
    id: 'ip_route',
    words: ['ip', 'route'],
    aliases: [['ip', 'r']],
    flags: [F('-4'), F('-6')],
    positional: 'none',
    sub: true,
    examples: ['ip route'],
  },
  {
    id: 'ss',
    words: ['ss'],
    flags: [F('-t'), F('-u'), F('-l'), F('-n'), F('-p')],
    positional: 'none',
    examples: ['ss -tuln', 'ss -tlnp'],
  },
  {
    id: 'systemctl_status',
    words: ['systemctl', 'status'],
    flags: [F('--no-pager'), F('-l')],
    positional: 'name',
    sub: true,
    caveat: true,
    examples: ['systemctl status ssh --no-pager'],
  },
  {
    id: 'journalctl',
    words: ['journalctl'],
    flags: [F('-u', 'word'), F('-n', 'number'), F('--no-pager'), F('-f'), F('-e')],
    positional: 'none',
    caveat: true,
    examples: ['journalctl -u ssh -n 50 --no-pager'],
  },
  {
    id: 'docker_ps',
    words: ['docker', 'ps'],
    flags: [F('-a'), F('-q'), F('--no-trunc')],
    positional: 'none',
    sub: true,
    examples: ['docker ps', 'docker ps -a'],
  },
  {
    id: 'docker_images',
    words: ['docker', 'images'],
    flags: [F('-a'), F('-q')],
    positional: 'none',
    sub: true,
    examples: ['docker images'],
  },
  {
    id: 'docker_logs',
    words: ['docker', 'logs'],
    flags: [F('--tail', 'number'), F('-f'), F('-t')],
    positional: 'name',
    sub: true,
    caveat: true,
    examples: ['docker logs --tail 100 mycontainer'],
  },
  {
    id: 'docker_inspect',
    words: ['docker', 'inspect'],
    flags: [],
    positional: 'name',
    sub: true,
    caveat: true,
    examples: ['docker inspect mycontainer'],
  },
];

/** Words that make a command change things or run other programs: never explained. */
const ACTION_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);

/** Shell syntax: pipes, redirects, expansions, quoting, substitution, variables, globbing. */
const SHELL_SYNTAX = /[|&;<>()$`\\{}*?[\]~!"'#=\n\r\t\0^]/;
const SAFE_WORD = /^[A-Za-z0-9_@.:,/+%-]+$/;
const MAX_LENGTH = 160;

export interface Explanation {
  def: CommandDef;
  /** Options found in the text that the reference knows: flag + translation key. */
  options: { flag: string; key: string }[];
  /** Options in the text that the reference does not explain. */
  unknown: string[];
  /** Words after the command that are plain arguments (paths, names, patterns). */
  hasArguments: boolean;
}

export type Outcome = { ok: true; explanation: Explanation } | { ok: false; reason: 'none' };

export const flagKey = (flag: string): string =>
  flag.startsWith('--')
    ? `l_${flag.slice(2)}`
    : flag.startsWith('-')
      ? `s_${flag.slice(1)}`
      : `p_${flag}`;

const NO: Outcome = { ok: false, reason: 'none' };

function valueOk(kind: ValueKind | undefined, token: string | undefined): boolean {
  if (token === undefined) return false;
  if (kind === 'number') return /^[+-]?\d{1,6}$/.test(token);
  if (kind === 'time') return /^[\w:.+-]{1,40}$/.test(token);
  return SAFE_WORD.test(token);
}

/**
 * Explains explicitly selected text. Returns `none` for anything that is not
 * plainly one known command (shell syntax, unknown commands, privilege
 * wrappers, actions that modify things, over-long input).
 */
export function explain(selection: string): Outcome {
  const text = selection.trim().replace(/ {2,}/g, ' ');
  if (!text || text.length > MAX_LENGTH || SHELL_SYNTAX.test(text)) return NO;
  const tokens = text.split(' ');
  if (tokens.some((t) => !SAFE_WORD.test(t))) return NO;
  if (tokens.some((t) => ACTION_FLAGS.has(t))) return NO;

  // Find the command: first word, then (for sub-commands) the first word that is not an option.
  const first = tokens[0]!;
  const rest = tokens.slice(1);
  let def: CommandDef | undefined;
  let consumed = 0;
  const candidates = COMMANDS.filter(
    (c) => c.words[0] === first || c.aliases?.some((a) => a[0] === first),
  );
  for (const c of candidates) {
    if (!c.sub) {
      def = c;
      break;
    }
    const subIndex = rest.findIndex((t) => !t.startsWith('-'));
    if (subIndex === -1) continue;
    const sub = rest[subIndex]!;
    const names = [c.words[1], ...(c.aliases ?? []).map((a) => a[1])];
    if (names.includes(sub)) {
      // Options before the sub-command (ip -br addr) belong to the command.
      def = c;
      consumed = subIndex + 1;
      break;
    }
  }
  if (!def) return NO;

  const args = consumed ? [...rest.slice(0, consumed - 1), ...rest.slice(consumed)] : rest;
  const options: Explanation['options'] = [];
  const unknown: string[] = [];
  let hasArguments = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--') {
      hasArguments = args.length > i + 1 || hasArguments;
      break;
    }
    if (token.startsWith('-') && token.length > 1) {
      const whole = def.flags.find((f) => f.flag === token);
      if (whole) {
        options.push({ flag: token, key: flagKey(token) });
        if (whole.value) {
          if (!valueOk(whole.value, args[i + 1])) return NO;
          i += 1; // the option's value is not an "argument" to interpret
        }
        continue;
      }
      if (token.startsWith('--')) {
        unknown.push(token);
        continue;
      }
      // A cluster of single-letter options: -la = -l -a.
      for (const letter of token.slice(1)) {
        const f = def.flags.find((x) => x.flag === `-${letter}`);
        if (f && !f.value) options.push({ flag: `-${letter}`, key: flagKey(`-${letter}`) });
        else if (f?.value) {
          options.push({ flag: `-${letter}`, key: flagKey(`-${letter}`) });
          // `-n20` style value glued to the letter is not interpreted
        } else unknown.push(`-${letter}`);
      }
      continue;
    }
    // positional
    if (def.literals?.includes(token)) {
      options.push({ flag: token, key: flagKey(token) });
      continue;
    }
    switch (def.positional) {
      case 'none':
        return NO; // e.g. `hostname newname` would change something: not explained
      case 'format':
        if (!token.startsWith('+')) return NO; // `date 010112002026` would set the clock
        hasArguments = true;
        break;
      default:
        hasArguments = true;
    }
  }
  // Deduplicate repeated options (-ll).
  const seen = new Set<string>();
  const unique = options.filter((o) => !seen.has(o.flag) && seen.add(o.flag));
  return {
    ok: true,
    explanation: { def, options: unique, unknown: [...new Set(unknown)], hasArguments },
  };
}

/** Lower-case words of a command for searching the reference. */
export const searchText = (c: CommandDef): string =>
  `${c.words.join(' ')} ${c.id.replace('_', ' ')}`;
