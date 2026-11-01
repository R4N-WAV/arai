import type { ReactNode } from 'react';
import { Logo } from '../components/Icons';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-panel">
        <a className="brand" href="/"><Logo /> Arai</a>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }} role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </span>
  );
}
