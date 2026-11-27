import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The test entry, not src/index.ts: it is the only Worker that accepts test identities.
      main: './test/support/test-worker.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test values for the Planning Center OAuth application's secrets, the email hash key and
        // the KLIPY API key.
        bindings: {
          PCO_CLIENT_ID: 'phon-test-client',
          PCO_CLIENT_SECRET: 'phon-test-secret',
          EMAIL_HASH_KEY: 'phon-test-email-hash-key',
          KLIPY_API_KEY: 'phon-test-klipy-key',
        },
        // A local bucket, which replaces the wrangler.jsonc binding: no test reaches a real one,
        // even if that binding later sets `remote: true`.
        r2Buckets: { IMAGES: 'phon-images-test' },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/support/setup.ts'],
    // WebSockets to Durable Objects are not supported with per-file storage isolation (the
    // integration's known issues), so the files share one runtime. Each test seeds its own church.
    maxWorkers: 1,
    isolate: false,
  },
})
