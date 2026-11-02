import { describe, expect, it } from 'vitest';
import { Client, registered } from './helpers';

describe('web push', () => {
  it('publishes the VAPID key and accepts only real push-service endpoints', async () => {
    const key = (await new Client().call('GET', '/push/key')).json.key;
    expect(key).toMatch(/^[A-Za-z0-9_-]{87}$/); // 65-byte uncompressed P-256 point
    expect((await new Client().call('GET', '/config')).json.push).toBe(true);
    const { c } = await registered('push_user');
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://localhost/x', 'https://fcm.googleapis.com:8443/x', 'https://169.254.169.254/latest']) {
      expect((await c.call('POST', '/push/subscriptions', { endpoint })).status).toBe(400);
    }
    expect((await c.call('POST', '/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })).status).toBe(201);
    expect((await c.call('DELETE', '/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })).status).toBe(200);
    expect((await new Client().call('POST', '/push/subscriptions', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })).status).toBe(401);
  });

  it('summarises what woke the device with names and counts only', async () => {
    const { c } = await registered('push_ana');
    const { c: ben } = await registered('push_ben');
    await ben.call('POST', '/social/push_ana/follow');
    const s = (await c.call('GET', '/push/summary')).json;
    expect(s).toMatchObject({ unread: 1, latest: { kind: 'follow', actor: 'push_ben' }, unreadMessages: 0 });
  });
});
