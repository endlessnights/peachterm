// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { t } from '../../i18n';
import type { ConnectionTree, Uuid } from '../../shared/types';
import { MAX_FOLDER_DEPTH, folderLevel } from './treeOps';

export const MAX_FOLDER_NAME = 128;
export const MAX_FOLDER_PATH = 3 * MAX_FOLDER_NAME + 8;

/** Why a folder path cannot be created below `parent`, or null (Rust checks again). */
export function validateFolderPath(
  tree: ConnectionTree,
  parent: Uuid | null,
  input: string,
): string | null {
  const path = input.trim();
  if (!path) return t('common.enterValue');
  if (path.length > MAX_FOLDER_PATH) return t('errors.folders.pathInvalid');
  const names = path.split('/').map((s) => s.trim());
  for (const name of names) {
    // `/abs`, `a//b`, `a/` give empty parts; . and .. would escape or repeat.
    if (name === '' || name === '.' || name === '..') return t('errors.folders.pathInvalid');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return t('errors.folders.pathInvalid');
    if ([...name].length > MAX_FOLDER_NAME) return t('errors.folders.pathInvalid');
  }
  const base = parent ? folderLevel(tree, parent) : 0;
  if (base + names.length > MAX_FOLDER_DEPTH) {
    return t('errors.folders.tooDeep', { max: MAX_FOLDER_DEPTH });
  }
  return null;
}
