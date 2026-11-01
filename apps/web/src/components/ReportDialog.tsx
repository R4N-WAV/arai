import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { Modal } from './Modal';
import { Notice } from './Unavailable';

const REASONS = [
  ['spam', 'Spam or scams'],
  ['harassment', 'Harassment or bullying'],
  ['hate', 'Hate'],
  ['sexual', 'Sexual content'],
  ['violence', 'Violence or threats'],
  ['copyright', 'Copyright'],
  ['impersonation', 'Pretending to be someone else'],
  ['other', 'Something else'],
] as const;

export function ReportDialog({ open, onClose, targetType, targetId, label, evidence }: { open: boolean; onClose: () => void; targetType: 'user' | 'project' | 'comment' | 'message'; targetId: string; label: string; evidence?: string }) {
  const [reason, setReason] = useState<string>('spam');
  const [details, setDetails] = useState('');
  const [share, setShare] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) (setState('idle'), setError(null), setDetails(''), setShare(false));
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    try {
      await api('POST', '/reports', { targetType, targetId, reason, details, ...(share && evidence ? { evidence: evidence.slice(0, 4000) } : {}) });
      setState('done');
    } catch (err) {
      setError(errorMessage(err));
      setState('idle');
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Report ${label}`}>
      {state === 'done' ? (
        <>
          <Notice kind="ok">Thanks. The report reached Arai’s moderators.</Notice>
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </>
      ) : (
        <form className="share-form" onSubmit={submit}>
          {error && <Notice kind="error">{error}</Notice>}
          <label className="field">
            <span className="field-label">What is wrong?</span>
            <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Anything moderators should know (optional)</span>
            <textarea className="input" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} rows={3} />
          </label>
          {evidence !== undefined && (
            <label className="check">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Include the text of this message (it is end-to-end encrypted, so moderators cannot see it otherwise)
            </label>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={state === 'busy'}>Send report</button>
        </form>
      )}
    </Modal>
  );
}
