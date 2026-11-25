// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { Trans, useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { formatSize } from '../sftp/model';
import { useEditor, type EditorQuestion } from './store';

/** The oldest open question; the rest wait their turn (never stacked). */
export function EditorPromptHost() {
  const question = useEditor((s) => s.questions[0]);
  if (!question) return null;
  return question.kind === 'confirm' ? (
    <ConfirmUpload key={`c-${question.editId}-${question.size}`} question={question} />
  ) : (
    <ConflictDialog key={`x-${question.editId}`} question={question} />
  );
}

function ConfirmUpload({ question }: { question: Extract<EditorQuestion, { kind: 'confirm' }> }) {
  const { t } = useTranslation();
  const answer = useEditor((s) => s.answer);
  const reply = (value: 'yes' | 'yesToAll' | 'no' | 'cancel') =>
    void answer(question.editId, value);
  return (
    <Dialog
      title={t('editor.uploadTitle')}
      onClose={() => reply('cancel')}
      persistent
      footer={
        <>
          <button className="btn" onClick={() => reply('cancel')}>
            {t('common.cancel')}
          </button>
          <button className="btn" onClick={() => reply('no')}>
            {t('editor.no')}
          </button>
          <button className="btn" onClick={() => reply('yesToAll')}>
            {t('editor.yesAll')}
          </button>
          <button className="btn btn-primary" onClick={() => reply('yes')} data-autofocus>
            {t('editor.yes')}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p>
          <Trans
            i18nKey="editor.uploadBody"
            values={{ name: question.name, size: formatSize(question.size) }}
            components={{ strong: <strong /> }}
          />
        </p>
        <dl className="fingerprint">
          <dt>{t('editor.remotePath')}</dt>
          <dd className="mono">{question.remotePath}</dd>
        </dl>
        <p className="hint">
          <Trans i18nKey="editor.yesAllHint" components={{ strong: <strong /> }} />
        </p>
      </div>
    </Dialog>
  );
}

function ConflictDialog({ question }: { question: Extract<EditorQuestion, { kind: 'conflict' }> }) {
  const { t } = useTranslation();
  const resolve = useEditor((s) => s.resolveConflict);
  return (
    <Dialog
      title={t('editor.conflictTitle')}
      onClose={() => void resolve(question.editId, 'keepLocal')}
      persistent
      footer={
        <>
          <button
            className="btn btn-danger"
            onClick={() => void resolve(question.editId, 'overwrite')}
          >
            {t('editor.overwrite')}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void resolve(question.editId, 'keepLocal')}
            data-autofocus
          >
            {t('editor.keepLocal')}
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="callout callout-danger">
          <Trans
            i18nKey="editor.conflictBody"
            values={{ name: question.name }}
            components={{ strong: <strong /> }}
          />
        </p>
        <dl className="fingerprint">
          <dt>{t('editor.remotePath')}</dt>
          <dd className="mono">{question.remotePath}</dd>
        </dl>
        <p className="hint">{t('editor.conflictHint')}</p>
      </div>
    </Dialog>
  );
}
