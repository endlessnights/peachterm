// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

// Builds the Tauri configuration overlay that turns on signed in-app updates for an
// OFFICIAL release build. It is merged over tauri.conf.json with `tauri build --config`.
//
//   TAURI_UPDATER_PUBKEY=<contents of the .pub file> node scripts/updater-config.mjs > updater.conf.json
//
// Only the PUBLIC key goes in here (it is built into the application, where users'
// copies use it to verify updates). The private key never touches this script or the
// repository: it is read by `tauri build` from the TAURI_SIGNING_PRIVATE_KEY secret.
// The update endpoint is fixed and must be HTTPS; nothing can override it.

import { fileURLToPath } from 'node:url';

export const ENDPOINT =
  'https://github.com/endlessnights/peachterm/releases/latest/download/latest.json';

/** `tauri signer generate` writes the public key as base64 of a minisign key file. */
export function validatePubkey(value) {
  const key = (value ?? '').trim();
  if (!key) throw new Error('TAURI_UPDATER_PUBKEY is empty.');
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(key) || key.length < 60 || key.length > 400) {
    throw new Error(
      'TAURI_UPDATER_PUBKEY is not a base64 public key from `tauri signer generate`.',
    );
  }
  const text = Buffer.from(key, 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:') || /SECRET KEY/i.test(text)) {
    throw new Error(
      'TAURI_UPDATER_PUBKEY must be the PUBLIC key (the .pub file), not the private key.',
    );
  }
  return key.replace(/\s+/g, '');
}

export function buildConfig(pubkey) {
  if (!ENDPOINT.startsWith('https://')) throw new Error('The update endpoint must use HTTPS.');
  return {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: validatePubkey(pubkey),
        endpoints: [ENDPOINT],
        windows: { installMode: 'passive' },
      },
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(
      `${JSON.stringify(buildConfig(process.env.TAURI_UPDATER_PUBKEY), null, 2)}\n`,
    );
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
