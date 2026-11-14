/** /storage/callback: the cloud provider sends the browser back here after consent. */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Notice } from '../components/Unavailable';
import { finishConnect, PROVIDER_NAME, setUploadTarget } from '../lib/cloud';
import { useSession } from '../lib/session';

export function StorageCallback() {
  const { keys } = useSession();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (!keys || once.current) return;
    once.current = true;
    finishConnect(keys, new URLSearchParams(location.search))
      .then((p) => {
        setUploadTarget(p);
        nav(`/settings?connected=${p}`, { replace: true });
      })
      .catch((e: Error) => setError(e.message === 'cancelled' || e.message === 'access_denied' ? 'Connecting was cancelled.' : `Connecting did not work (${e.message}). Try again from Settings.`));
  }, [keys, nav]);
  return (
    <>
      <header className="page-header"><h1>Connecting storage</h1></header>
      {error ? (
        <>
          <Notice kind="error">{error}</Notice>
          <Link to="/settings" className="btn btn-sm">Back to Settings</Link>
        </>
      ) : (
        <p className="muted" role="status">Securing the connection… ({Object.values(PROVIDER_NAME).join(' / ')})</p>
      )}
    </>
  );
}
