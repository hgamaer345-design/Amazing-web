import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_MAX_UPLOAD_BYTES, ACCEPTED_EXTENSIONS, type AppConfigResponse } from '../../shared/types';
import { getConfig } from '../api';

export interface AppConfigState {
  config: AppConfigResponse;
  /** False until /api/config has answered (the fallback config is used meanwhile). */
  loaded: boolean;
  /** Set when the config request failed (e.g. server down). */
  error: string | null;
}

const FALLBACK: AppConfigResponse = {
  provider: null,
  providerConfigured: true, // assume OK until the server says otherwise, to avoid a flash of the warning
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  acceptedExtensions: ACCEPTED_EXTENSIONS,
  supportsSpeakerCount: true,
  maxSpeakers: 10,
};

const ConfigContext = createContext<AppConfigState>({ config: FALLBACK, loaded: false, error: null });

export function AppConfigProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppConfigState>({ config: FALLBACK, loaded: false, error: null });
  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((config) => !cancelled && setState({ config, loaded: true, error: null }))
      .catch((err: Error) => !cancelled && setState({ config: FALLBACK, loaded: true, error: err.message }));
    return () => {
      cancelled = true;
    };
  }, []);
  return <ConfigContext.Provider value={state}>{children}</ConfigContext.Provider>;
}

export function useAppConfig(): AppConfigState {
  return useContext(ConfigContext);
}
