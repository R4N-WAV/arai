import type { ReactNode } from 'react';
import { HomeLink } from '../components/Logo';

export function AuthLayout({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-panel">
        <HomeLink />
        <h1>{title}</h1>
        {lede && <p className="voice auth-lede">{lede}</p>}
        {children}
      </div>
    </main>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }} role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </span>
  );
}
