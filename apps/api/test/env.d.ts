// Test-time typing for `cloudflare:workers` env/exports.
import type { D1Migration } from 'cloudflare:test';
import type { Env as AraiEnv } from '../src/env.js';

declare global {
  namespace Cloudflare {
    interface Env extends AraiEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import('../src/index.js');
    }
  }
}
