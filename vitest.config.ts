import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against sources, so no build is needed before `npm test`.
    alias: {
      '@figtional/fig-format': pkg('fig-format'),
      '@figtional/fig-model': pkg('fig-model'),
      '@figtional/fig-render': pkg('fig-render'),
      '@figtional/mcp-server': pkg('mcp-server'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
