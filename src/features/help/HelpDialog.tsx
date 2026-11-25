// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { notify } from '../../components/Toasts';
import { t as tr } from '../../i18n';
import { copyText } from '../notes/DocView';
import { COMMANDS, explain, searchText, type CommandDef } from './reference';

type Tr = (key: string, options?: Record<string, unknown>) => string;

/** Dynamic reference keys cannot be checked by the typed resources. */
const ref = (t: unknown): Tr => t as Tr;

function Examples({ def }: { def: CommandDef }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('help.explain.examples')}>
      <h4>{t('help.explain.examples')}</h4>
      <ul className="help-examples">
        {def.examples.map((command) => (
          <li key={command}>
            <code>{command}</code>
            <button
              className="btn"
              type="button"
              aria-label={t('help.explain.copyAria', { command })}
              onClick={() =>
                void copyText(command).then((ok) =>
                  notify(ok ? tr('help.explain.copied') : tr('notes.copyFailed')),
                )
              }
            >
              {t('help.explain.copy')}
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">{t('help.explain.exampleNote')}</p>
    </section>
  );
}

function CommandView({
  def,
  options,
  unknown = [],
  hasArguments = false,
}: {
  def: CommandDef;
  options: { flag: string; key: string }[];
  unknown?: string[];
  hasArguments?: boolean;
}) {
  const { t } = useTranslation();
  const r = ref(t);
  const flagsToShow = options.length > 0 ? options : [];
  return (
    <div className="help-command">
      <p>{r(`help.cmd.${def.id}.summary`)}</p>
      {flagsToShow.length > 0 && (
        <>
          <h4>{t('help.explain.options')}</h4>
          <dl className="help-flags">
            {flagsToShow.map((o) => (
              <div key={o.flag}>
                <dt>
                  <code>{o.flag}</code>
                </dt>
                <dd>{r(`help.cmd.${def.id}.flag.${o.key}`)}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {unknown.length > 0 && (
        <p className="hint">{t('help.explain.unknownOptions', { list: unknown.join(' ') })}</p>
      )}
      {hasArguments && <p className="hint">{t('help.explain.arguments')}</p>}
      {def.caveat && (
        <div className="notice notice-warn">
          <strong>{t('help.explain.caveat')}</strong>
          <div>{r(`help.cmd.${def.id}.caveat`)}</div>
        </div>
      )}
      <Examples def={def} />
    </div>
  );
}

/** Every flag of a reference entry, for the browsable reference. */
function ReferenceEntry({ def }: { def: CommandDef }) {
  const options = def.flags.map((f) => ({
    flag: f.flag,
    key: f.flag.startsWith('--') ? `l_${f.flag.slice(2)}` : `s_${f.flag.slice(1)}`,
  }));
  for (const literal of def.literals ?? []) options.push({ flag: literal, key: `p_${literal}` });
  return <CommandView def={def} options={options} />;
}

export function HelpDialog({
  mode,
  text,
  onClose,
}: {
  mode: 'explain' | 'reference';
  text?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const r = ref(t);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const outcome = useMemo(() => (mode === 'explain' ? explain(text ?? '') : null), [mode, text]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return COMMANDS.filter((c) => !q || searchText(c).toLowerCase().includes(q));
  }, [query]);
  const selected = open ? COMMANDS.find((c) => c.id === open) : undefined;

  return (
    <Dialog
      title={t('help.dialog.title')}
      onClose={onClose}
      wide
      footer={
        <button className="btn btn-primary" onClick={onClose} data-autofocus>
          {t('common.close')}
        </button>
      }
    >
      <div className="dialog-body help-dialog">
        {mode === 'explain' ? (
          <>
            <h4>{t('help.explain.selected')}</h4>
            <pre className="help-selected" data-testid="help-selected">
              {(text ?? '').slice(0, 400)}
            </pre>
            {outcome?.ok ? (
              <CommandView
                def={outcome.explanation.def}
                options={outcome.explanation.options}
                unknown={outcome.explanation.unknown}
                hasArguments={outcome.explanation.hasArguments}
              />
            ) : (
              <p role="status">
                {(text ?? '').trim() ? t('help.explain.none') : t('help.explain.noSelection')}
              </p>
            )}
            <p className="hint">{t('help.explain.disclaimer')}</p>
          </>
        ) : selected ? (
          <>
            <button className="btn" onClick={() => setOpen(null)}>
              ← {t('help.explain.back')}
            </button>
            <h4>
              <code>{selected.words.join(' ')}</code>
            </h4>
            <ReferenceEntry def={selected} />
          </>
        ) : (
          <>
            <h4>{t('help.dialog.reference')}</h4>
            <input
              className="input"
              type="search"
              placeholder={t('help.explain.search')}
              aria-label={t('help.explain.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-autofocus
            />
            <ul className="help-list" aria-label={t('help.dialog.reference')}>
              {shown.map((c) => (
                <li key={c.id}>
                  <button className="help-row" onClick={() => setOpen(c.id)}>
                    <code>{c.words.join(' ')}</code>
                    <span>{r(`help.cmd.${c.id}.summary`)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="hint">{t('help.explain.reviewNote')}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
