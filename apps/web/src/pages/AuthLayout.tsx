import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Logo } from '../components/Icons';

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-panel">
        <Link className="brand" to="/"><Logo /> Arai</Link>
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
