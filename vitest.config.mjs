import { defineConfig } from 'vitest/config'

// The root's own tests: the env wrapper's, in `scripts/lib/` (eng-pipeline#54), and the private
// terms check's, in `scripts/` (phon#270). Each package runs its own tests from its own folder
// (`pnpm -r test`), so this config collects nothing else.
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.mjs'],
  },
})
