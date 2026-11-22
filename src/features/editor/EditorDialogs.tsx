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
  const answer = useEditor((s) => s.answer);
  const reply = (value: 'yes' | 'yesToAll' | 'no' | 'cancel') =>
    void answer(question.editId, value);
  return (
    <Dialog
      title="Remote file modified"
      onClose={() => reply('cancel')}
      persistent
      footer={
        <>
          <button className="btn" onClick={() => reply('cancel')}>
            Cancel
          </button>
          <button className="btn" onClick={() => reply('no')}>
            No
          </button>
          <button className="btn" onClick={() => reply('yesToAll')}>
            Yes to all
          </button>
          <button className="btn btn-primary" onClick={() => reply('yes')} data-autofocus>
            Yes
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p>
          <strong>{question.name}</strong> was changed in your editor ({formatSize(question.size)}).
          Upload it to the server and replace the remote file?
        </p>
        <dl className="fingerprint">
          <dt>Remote path</dt>
          <dd className="mono">{question.remotePath}</dd>
        </dl>
        <p className="hint">
          <strong>Yes to all</strong> uploads further saves of files in this SSH connection without
          asking, until it ends. It is never saved: a new or restored connection asks again.
        </p>
      </div>
    </Dialog>
  );
}

function ConflictDialog({ question }: { question: Extract<EditorQuestion, { kind: 'conflict' }> }) {
  const resolve = useEditor((s) => s.resolveConflict);
  return (
    <Dialog
      title="Remote file changed"
      onClose={() => void resolve(question.editId, 'keepLocal')}
      persistent
      footer={
        <>
          <button
            className="btn btn-danger"
            onClick={() => void resolve(question.editId, 'overwrite')}
          >
            Overwrite remote file
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void resolve(question.editId, 'keepLocal')}
            data-autofocus
          >
            Keep my local copy only
          </button>
        </>
      }
    >
      <div className="dialog-body">
        <p className="callout callout-danger">
          <strong>{question.name}</strong> was changed on the server after you opened it. Uploading
          now would discard those remote changes.
        </p>
        <dl className="fingerprint">
          <dt>Remote path</dt>
          <dd className="mono">{question.remotePath}</dd>
        </dl>
        <p className="hint">
          Your edit stays in the local copy; nothing was sent. You can save again later to retry.
        </p>
      </div>
    </Dialog>
  );
}
