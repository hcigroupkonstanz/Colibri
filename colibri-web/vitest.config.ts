import { defineConfig } from 'vitest/config';

export default defineConfig({
    esbuild: { target: 'es2022' },
    test: {
        environment: 'node',
        globals: false,
        include: ['test/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/index.ts'],
        },
    },
});
