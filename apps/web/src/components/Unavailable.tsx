import type { ReactNode } from 'react';

/**
 * A feature that depends on an external provider (email delivery, SMS) that
 * is not configured yet. Rendered greyed out with an explanation; the control
 * is disabled and never pretends to work. Swap for the real control once the
 * capability flag turns on.
 */
export function Unavailable({ title, reason, action }: { title: string; reason: string; action: string }) {
  return (
    <div className="row unavailable">
      <div>
        <div className="unavailable-title">
          <strong>{title}</strong> <span className="badge">Not available yet</span>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>{reason}</p>
      </div>
      <button type="button" className="btn" disabled aria-disabled="true">
        {action}
      </button>
    </div>
  );
}

export const EMAIL_REASON = 'Needs an email delivery service, which will be set up later.';
export const SMS_REASON = 'Needs a paid SMS provider, which will be set up later.';

export function Notice({ kind, children }: { kind: 'error' | 'ok' | 'warn'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
