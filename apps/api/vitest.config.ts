import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// A throwaway Web Push (VAPID) key for tests (WebCrypto: no Node typings needed).
async function testVapid(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          // Test-only secrets; production values are set via `wrangler secret put`.
          AUTH_PEPPER: 'test-pepper',
          KDF_SALT_SECRET: 'test-kdf-salt-secret',
          IP_HMAC_SECRET: 'test-ip-secret',
          VAPID_PRIVATE_JWK: await testVapid(),
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
