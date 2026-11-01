import { useId, useState, type InputHTMLAttributes } from 'react';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
}

export function Field({ label, hint, error, type = 'text', ...rest }: Props) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const [shown, setShown] = useState(false);
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const isPassword = type === 'password';
  const input = (
    <input id={id} className="input" type={isPassword && shown ? 'text' : type} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
  );
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isPassword ? (
        <div className="pw-wrap">
          {input}
          <button type="button" className="btn btn-ghost pw-toggle" aria-pressed={shown} aria-controls={id} onClick={() => setShown((s) => !s)}>
            {shown ? 'Hide' : 'Show'}
            <span className="visually-hidden"> password</span>
          </button>
        </div>
      ) : (
        input
      )}
      {hint && <p className="hint" id={hintId}>{hint}</p>}
      {error && <p className="error" id={errId}>{error}</p>}
    </div>
  );
}
