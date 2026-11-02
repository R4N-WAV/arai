export interface Env {
  DB: D1Database;
  FILES: DurableObjectNamespace<import('./filestore.js').FileStore>;
  HUB: DurableObjectNamespace<import('./hub.js').UserHub>;
  USER_QUOTA_BYTES: string;
  PLATFORM_QUOTA_BYTES: string;
  /** Provider-gated features. "on" only once a real provider is configured. */
  FEATURE_EMAIL: 'on' | 'off';
  FEATURE_SMS: 'on' | 'off';
  FEATURE_GIFS?: 'on' | 'off';
  GIF_API_KEY?: string;
  /** P-256 private key (JWK JSON) for Web Push (VAPID). Created by the deploy job. */
  VAPID_PRIVATE_JWK?: string;
  REQUIRE_TURNSTILE?: 'true' | 'false';
  TURNSTILE_SITE_KEY?: string;
  AUTH_PEPPER?: string;
  KDF_SALT_SECRET?: string;
  IP_HMAC_SECRET?: string;
  TURNSTILE_SECRET?: string;
}

export type AppBindings = { Bindings: Env; Variables: { requestId: string; /** users to wake with a push after this request */ wake?: string[] } };
