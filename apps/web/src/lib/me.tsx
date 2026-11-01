import type { ProfileDto } from '@arai/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

interface MeState {
  profile: ProfileDto | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<MeState>({ profile: null, refresh: async () => undefined });

/** The signed-in user's own public profile (for the avatar in the shell). */
export function MeProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const refresh = useCallback(async () => {
    try {
      setProfile((await api<{ profile: ProfileDto }>('GET', '/account/profile')).profile);
    } catch {
      /* the shell falls back to the initial */
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return <Ctx.Provider value={{ profile, refresh }}>{children}</Ctx.Provider>;
}

export const useMe = () => useContext(Ctx);
