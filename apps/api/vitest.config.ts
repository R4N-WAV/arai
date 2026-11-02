import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { generateKeyPairSync } from 'node:crypto';
import { defineConfig } from 'vitest/config';

// A throwaway Web Push (VAPID) key for tests.
const vapid = JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }));

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
          VAPID_PRIVATE_JWK: vapid,
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
