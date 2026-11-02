import type { AccountKeys } from '@arai/crypto';
import type { Capabilities, SessionUser } from '@arai/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { UnlockInfo } from './account';
import { forgetStreams } from './stream';
import { forgetAllTabs, rememberForTab, restoreForTab } from './tabvault';

interface SessionState {
  loading: boolean;
  user: SessionUser | null;
  unlockInfo: UnlockInfo | null;
  /** Decrypted keys live only in memory; a reload requires unlocking again. */
  keys: AccountKeys | null;
  caps: Capabilities;
  setSignedIn: (user: SessionUser | null, keys: AccountKeys | null) => void;
  setKeys: (keys: AccountKeys) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const DEFAULT_CAPS: Capabilities = { emailDelivery: false, sms: false, gifs: false, turnstileSiteKey: null };
const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [unlockInfo, setUnlockInfo] = useState<UnlockInfo | null>(null);
  const [keys, setKeysState] = useState<AccountKeys | null>(null);
  const [caps, setCaps] = useState<Capabilities>(DEFAULT_CAPS);

  const refresh = useCallback(async () => {
    try {
      const s = await api<{ user: SessionUser; unlock: UnlockInfo }>('GET', '/auth/session');
      setUser(s.user);
      setUnlockInfo(s.unlock);
      // Same tab reloaded? Restore keys without asking for the password again.
      const restored = await restoreForTab(s.user.id, s.unlock.encPrivateKeys);
      if (restored) setKeysState((k) => k ?? restored);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.warn('session check failed');
      setUser(null);
      setUnlockInfo(null);
      setKeysState(null);
      if (e instanceof ApiError && e.status === 401) void forgetAllTabs();
    }
  }, []);

  useEffect(() => {
    void Promise.all([refresh(), api<Capabilities>('GET', '/config').then(setCaps).catch(() => setCaps(DEFAULT_CAPS))]).finally(() => setLoading(false));
  }, [refresh]);

  const value: SessionState = {
    loading,
    user,
    unlockInfo,
    keys,
    caps,
    setSignedIn: (u, k) => {
      setUser(u);
      setKeysState(k);
      if (u && k) void rememberForTab(u.id, k);
      if (u) void refresh();
    },
    setKeys: (k) => {
      setKeysState(k);
      if (user) void rememberForTab(user.id, k);
    },
    refresh,
    signOut: async () => {
      await api('POST', '/auth/logout').catch(() => undefined);
      await forgetAllTabs();
      await forgetStreams();
      setUser(null);
      setUnlockInfo(null);
      setKeysState(null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
