/** Same-origin JSON API client. Cookies are HttpOnly; nothing sensitive is stored in JS storage. */
export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Arai-CSRF': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'unknown_error');
  return data as T;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That username or password is not correct.',
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  username_taken: 'That username is taken. Choose another one.',
  invalid_request: 'Some details are not valid. Check the form and try again.',
  account_unavailable: 'This account is suspended or unavailable.',
  invalid_recovery: 'That username and recovery key do not match.',
  bot_check_failed: 'The automated-signup check failed. Reload the page and try again.',
  network_error: 'Arai could not be reached. Check your connection and try again.',
  vault_unlock_failed: 'Signed in, but your encryption keys could not be unlocked. Try again.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return MESSAGES[e.code] ?? 'Something went wrong. Try again.';
  if (e instanceof Error && MESSAGES[e.message]) return MESSAGES[e.message]!;
  return 'Something went wrong. Try again.';
}
