import { useCallback, useEffect, useState } from 'react';
import { Notice } from '../components/Unavailable';
import { api, errorMessage } from '../lib/api';

interface Stats { users: number; newUsers: number; active7: number; projects: number; publicProjects: number; storageBytes: number; platformQuota: number; messages: number; openReports: number; suspended: number }
interface Report {
  id: string; reporter: string | null; target_type: 'user' | 'project' | 'comment' | 'message'; target_id: string; reason: string; details: string; evidence: string | null;
  status: string; created_at: number; resolution: string | null; target: { label: string; status: string; publicText: string } | null;
}
interface Audit { intact: boolean; brokenAt: number | null; entries: Array<{ seq: number; at: number; actor: string | null; action: string; target: string | null }> }

const ACTIONS: Record<Report['target_type'], Array<[string, string]>> = {
  user: [['restrict_user', 'Restrict'], ['suspend_user', 'Suspend'], ['reactivate_user', 'Reactivate'], ['ban_user', 'Ban']],
  project: [['hide_project', 'Hide project'], ['unhide_project', 'Unhide'], ['suspend_user', 'Suspend owner']],
  comment: [['remove_item', 'Remove comment'], ['suspend_user', 'Suspend author']],
  message: [['remove_item', 'Remove message'], ['suspend_user', 'Suspend sender']],
};

export function AdminPage() {
  const [role, setRole] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [reports, setReports] = useState<Report[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [mod, setMod] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [me, st, rp, au] = await Promise.all([
        api<{ role: string }>('GET', '/admin/me'),
        api<Stats>('GET', '/admin/stats'),
        api<{ reports: Report[] }>('GET', `/admin/reports${closed ? '?status=closed' : ''}`),
        api<Audit>('GET', '/admin/audit'),
      ]);
      setRole(me.role);
      setStats(st);
      setReports(rp.reports);
      setAudit(au);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [closed]);
  useEffect(() => void load(), [load]);

  const act = async (r: Report, action: string) => {
    const note = window.prompt('Note for the audit log (optional)') ?? '';
    try {
      await api('POST', `/admin/reports/${r.id}`, { action, note });
      setStatus('Done. The action is in the audit log.');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (error && !role) return <><header className="page-header"><h1>Not found</h1></header><p className="muted">This page does not exist.</p></>;
  const mb = (b: number) => `${(b / 1048576).toFixed(0)} MB`;
  return (
    <>
      <header className="page-header">
        <h1>Administration</h1>
        <span className="voice">platform {role}</span>
      </header>
      {error && <Notice kind="error">{error}</Notice>}
      {status && <Notice kind="ok">{status}</Notice>}
      <p className="section-lede">Private projects, comments and messages are end-to-end encrypted. Moderators see public data and only what a reporter chose to include.</p>

      {stats && (
        <section className="section" aria-labelledby="st-h">
          <h2 id="st-h" className="section-title">Overview</h2>
          <dl className="insights admin-stats">
            {[
              ['Accounts', stats.users], ['New this week', stats.newUsers], ['Active this week', stats.active7], ['Projects', stats.projects],
              ['Public projects', stats.publicProjects], ['Messages', stats.messages], ['Open reports', stats.openReports], ['Suspended', stats.suspended],
              ['Storage', `${mb(stats.storageBytes)} of ${mb(stats.platformQuota)}`],
            ].map(([k, v]) => (
              <div className="stat" key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>
            ))}
          </dl>
        </section>
      )}

      <section className="section" aria-labelledby="rp-h">
        <h2 id="rp-h" className="section-title">Reports</h2>
        <div className="filters" role="group" aria-label="Show reports">
          <button type="button" className="filter" aria-pressed={!closed} onClick={() => setClosed(false)}>Open</button>
          <button type="button" className="filter" aria-pressed={closed} onClick={() => setClosed(true)}>Closed</button>
        </div>
        {reports === null ? <p className="muted">Loading…</p> : reports.length === 0 ? <p className="voice">Nothing to review.</p> : (
          <ul className="list">
            {reports.map((r) => (
              <li key={r.id} className="row report">
                <div className="row-main">
                  <div className="row-title">{r.target?.label ?? `${r.target_type} (gone)`} <span className="tag">{r.reason}</span> {r.target && <span className="tag">{r.target.status}</span>}</div>
                  <p className="row-sub">Reported by @{r.reporter ?? 'deleted'} · {new Date(r.created_at).toLocaleString()}{r.resolution && ` · ${r.resolution}`}</p>
                  {r.details && <p className="report-text">“{r.details}”</p>}
                  {r.target?.publicText && <p className="report-text muted">Public text: {r.target.publicText}</p>}
                  {r.evidence && <p className="report-text">Evidence shared by the reporter: “{r.evidence}”</p>}
                </div>
                {r.status === 'open' && (
                  <span className="form-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(r, 'dismiss')}>Dismiss</button>
                    {ACTIONS[r.target_type].filter(([a]) => a !== 'ban_user' || role === 'owner').map(([a, label]) => (
                      <button key={a} type="button" className={a === 'ban_user' ? 'btn btn-danger btn-sm' : 'btn btn-sm'} onClick={() => void act(r, a)}>{label}</button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {role === 'owner' && (
        <section className="section" aria-labelledby="md-h">
          <h2 id="md-h" className="section-title">Moderators</h2>
          <form className="form-actions" onSubmit={(e) => { e.preventDefault(); void api('POST', '/admin/moderators', { username: mod.replace(/^@/, ''), grant: true }).then(() => (setStatus(`@${mod} is a moderator.`), setMod(''))).catch((x) => setError(errorMessage(x))); }}>
            <label className="visually-hidden" htmlFor="mod-name">Username</label>
            <input id="mod-name" className="input input-sm" value={mod} onChange={(e) => setMod(e.target.value)} placeholder="username" />
            <button type="submit" className="btn btn-sm" disabled={!mod.trim()}>Make moderator</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={!mod.trim()} onClick={() => void api('POST', '/admin/moderators', { username: mod.replace(/^@/, ''), grant: false }).then(() => setStatus(`@${mod} is no longer a moderator.`)).catch((x) => setError(errorMessage(x)))}>Remove</button>
          </form>
        </section>
      )}

      {audit && (
        <section className="section" aria-labelledby="au-h">
          <h2 id="au-h" className="section-title">Audit log</h2>
          <Notice kind={audit.intact ? 'ok' : 'error'}>{audit.intact ? 'The hash chain is intact: no entry has been changed or removed.' : `The hash chain is broken at entry ${audit.brokenAt}. Investigate immediately.`}</Notice>
          <ul className="list">
            {audit.entries.slice(0, 25).map((e) => (
              <li key={e.seq} className="row">
                <div className="row-main">
                  <div className="row-title mono">{e.action}</div>
                  <p className="row-sub">#{e.seq} · {e.actor ? `@${e.actor}` : 'system'} · {new Date(e.at).toLocaleString()}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
