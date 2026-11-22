// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

describe('open-source metadata', () => {
  it('ships the unmodified Apache License 2.0', () => {
    const license = read('LICENSE');
    expect(license).toContain(
      'Apache License\n                           Version 2.0, January 2004',
    );
    expect(license.trimEnd().split('\n')).toHaveLength(202); // the official text is 202 lines
    // The terms themselves (before the appendix template) match the official text published by the ASF.
    const terms = license.split('END OF TERMS AND CONDITIONS')[0]!;
    expect(createHash('sha256').update(terms).digest('hex')).toBe(
      'ff723b9517cd70824737b1fae68e6007f1f644f59be5e90dd7dac54dc36d0b40',
    );
  });

  it('has the NOTICE with the original-project attribution', () => {
    expect(read('NOTICE')).toBe(
      [
        'PeachTerm',
        'Copyright 2026 Bakhti Baymukhamedov',
        '',
        'Original project:',
        'https://github.com/endlessnights',
        '',
        'Created and maintained by Bakhti Baymukhamedov.',
        '',
        'Contact:',
        'https://t.me/pycarrot2',
        '',
        'Licensed under the Apache License, Version 2.0.',
        '',
      ].join('\n'),
    );
  });

  it('uses the real author and Apache-2.0 in every package manifest', () => {
    const pkg = JSON.parse(read('package.json')) as {
      license: string;
      author: { name: string; url: string };
      repository: { url: string };
    };
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.author.name).toBe('Bakhti Baymukhamedov');
    expect(pkg.author.url).toBe('https://github.com/endlessnights');
    expect(pkg.repository.url).toContain('github.com/endlessnights/peachterm');
    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).toContain('license = "Apache-2.0"');
    expect(cargo).toContain('authors = ["Bakhti Baymukhamedov"]');
    expect(cargo).toContain('repository = "https://github.com/endlessnights/peachterm"');
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      bundle: { license: string; copyright: string; publisher: string; licenseFile: string };
    };
    expect(tauri.bundle).toMatchObject({
      license: 'Apache-2.0',
      copyright: 'Copyright 2026 Bakhti Baymukhamedov',
      publisher: 'Bakhti Baymukhamedov',
      licenseFile: '../LICENSE',
    });
  });

  it('packages the license files with the application', () => {
    const tauri = JSON.parse(read('src-tauri/tauri.conf.json')) as {
      bundle: { resources: Record<string, string> };
    };
    expect(Object.values(tauri.bundle.resources).sort()).toEqual([
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
    ]);
  });

  it('keeps AI providers out of the ownership and attribution lines', () => {
    for (const file of ['NOTICE', 'LICENSE', 'package.json', 'src-tauri/Cargo.toml']) {
      expect(read(file)).not.toMatch(/openai|anthropic|claude|chatgpt/i);
    }
    expect(read('README.md')).toContain('is not owned, endorsed or maintained by any AI provider');
  });

  it('only triggers releases from version tags, never from ordinary pushes', () => {
    const wf = read('.github/workflows/release.yml');
    expect(wf).not.toMatch(/branches:/);
    expect(wf).not.toMatch(/pull_request/);
    expect(wf).toMatch(/tags:/);
    expect(wf).toMatch(/draft/);
    expect(wf).toMatch(/permissions:\n {2}contents: read/);
  });
});
