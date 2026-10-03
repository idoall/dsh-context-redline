import { defineConfig } from 'vitest/config'

// Specs import src/ directly (never the built lib/ artifacts), so the suite
// runs with no build step.
//
// Lanes (docs/05-test-plan.md §1):
//   edit    — OUR pure-logic guardrails. Imports only `src/redline/**` and
//             `src/shared/**`: no `node:*`, no DOM, no React. Must always be green.
//   channel — OUR route-level guardrails. Captures the exact Fetch route the
//             Host half registers and calls it through the real RPC envelope.
//             Allowed to import `src/host/redline-channel.ts`; never `src/client/**`.
//   host    — upstream's own lane (fold/projection). Environment-dependent feed;
//             NOT a gate, but run it once whenever an upstream file is touched.
//   client  — upstream's own lane (React components, jsdom). NOT a gate.
//
// A new test directory needs its own project here, or `vitest run <dir>`
// reports "no test files found".
export default defineConfig({
  test: {
    reporters: ['dot'],
    projects: [
      {
        test: {
          name: 'edit',
          include: ['tests/edit/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'channel',
          include: ['tests/channel/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'host',
          include: ['tests/host/**/*.spec.ts', 'tests/shared/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        // The inlined primitives dist references a sourcemap it does not ship;
        // vite's warning is noise, so the client lane logs errors only.
        logLevel: 'error',
        test: {
          name: 'client',
          include: ['tests/client/**/*.spec.ts', 'tests/client/**/*.spec.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/client/setup.ts'],
          server: {
            deps: {
              // The primitives dist imports .module.css; inlining lets vite
              // transform it (externalized Node ESM would reject the .css).
              inline: ['@deepseek-ai/dsh-client-ui-primitives'],
            },
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/shared/types.ts'],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
})
