import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          APP_ORIGIN: 'https://arai.test',
          // Test-only secrets; production values are set via `wrangler secret put`.
          AUTH_PEPPER: 'test-pepper',
          KDF_SALT_SECRET: 'test-kdf-salt-secret',
          IP_HMAC_SECRET: 'test-ip-secret',
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
