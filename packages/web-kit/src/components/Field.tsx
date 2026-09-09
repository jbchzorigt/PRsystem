import type { ReactNode } from 'react';

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}

/**
 * A labelled control. The hint and the error are tied to the control through
 * `aria-describedby` by the caller (`describedBy` gives the ids), and the error
 * is a live region so a returned form reads its problem aloud.
 */
export function Field({ id, label, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint !== undefined ? (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {children}
      {error !== undefined ? (
        <p className="error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function describedBy(
  id: string,
  hint?: string,
  error?: string | undefined,
): string | undefined {
  const ids = [
    ...(hint !== undefined ? [`${id}-hint`] : []),
    ...(error !== undefined ? [`${id}-error`] : []),
  ];
  return ids.length === 0 ? undefined : ids.join(' ');
}
