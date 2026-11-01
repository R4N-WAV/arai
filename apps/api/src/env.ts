export interface Env {
  DB: D1Database;
  APP_ORIGIN: string;
  EMAIL_PROVIDER: 'console' | 'resend' | 'brevo';
  AUTH_PEPPER?: string;
  KDF_SALT_SECRET?: string;
  IP_HMAC_SECRET?: string;
  TURNSTILE_SECRET?: string;
  EMAIL_API_KEY?: string;
}

export type AppBindings = { Bindings: Env; Variables: { requestId: string } };
