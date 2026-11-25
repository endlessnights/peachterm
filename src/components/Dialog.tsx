// Copyright 2026 Bakhti Baymukhamedov
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useTranslation } from 'react-i18next';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Clicking the backdrop does not close the dialog (it holds editable state). */
  persistent?: boolean;
}

/** Modal dialog with focus trap-lite: focuses the first field, Esc closes. */
export function Dialog({ title, onClose, children, footer, wide, persistent }: DialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>(
        'input:not([type="checkbox"]), select, textarea, button.btn-primary',
      );
    first?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !persistent) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog${wide ? ' dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" />
          </button>
        </div>
        {children}
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            data-autofocus
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="dialog-body">{message}</div>
    </Dialog>
  );
}

interface PromptProps {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  hint?: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  title,
  label,
  initial,
  confirmLabel,
  hint,
  validate,
  onSubmit,
  onCancel,
}: PromptProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const value = inputRef.current?.value.trim() ?? '';
    const problem = validate ? validate(value) : value ? null : t('common.enterValue');
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit(value);
  };
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input
            ref={inputRef}
            className="input"
            defaultValue={initial}
            maxLength={255}
            aria-invalid={error ? true : undefined}
            onChange={() => setError(null)}
            data-autofocus
          />
        </label>
        {hint && <p className="hint">{hint}</p>}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
