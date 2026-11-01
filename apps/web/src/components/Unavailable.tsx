import type { ReactNode } from 'react';

/**
 * A feature that needs an external provider (email delivery, SMS) that is not
 * configured yet: shown muted with an explanation and a disabled control.
 * It never pretends to work. Swap for the real control once the capability
 * flag turns on.
 */
export function Unavailable({ title, reason, action }: { title: string; reason: string; action: string }) {
  return (
    <div className="row unavailable">
      <div className="row-main">
        <div className="row-title">
          {title}
          <span className="not-yet">not available yet</span>
        </div>
        <p className="row-sub">{reason}</p>
      </div>
      <button type="button" className="btn btn-sm" disabled>
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
