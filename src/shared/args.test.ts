import { describe, expect, it } from 'vitest';
import { formatArgs, parseArgs } from './args';

describe('argument text', () => {
  it('round-trips arguments containing spaces and quotes', () => {
    const args = ['-a', 'Visual Studio Code', '{file}', 'say "hi"', ''];
    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it('parses plain and quoted tokens', () => {
    expect(parseArgs('  -multiInst   "{file}" ')).toEqual(['-multiInst', '{file}']);
  });
});
