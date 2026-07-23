import { defineConfig } from 'vitest/config';

export default defineConfig({
    esbuild: { target: 'es2022' },
    test: {
        environment: 'node',
        globals: false,
        include: ['e2e/**/*.e2e.test.ts'],
        globalSetup: ['e2e/globalSetup.ts'],
        testTimeout: 20_000,
        hookTimeout: 300_000,
        fileParallelism: false,
        pool: 'forks',
        poolOptions: {
            forks: { singleFork: true },
        },
    },
});
