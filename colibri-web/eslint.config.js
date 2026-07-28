import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
    {
        ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // plain JS files (e.g. samples/remote-logging.js) run on Node, and unlike
        // the .ts files they are not covered by typescript-eslint's no-undef opt-out
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        languageOptions: {
            globals: {
                console: 'readonly',
                process: 'readonly',
            },
        },
    },
    {
        rules: {
            'no-useless-constructor': 'off',
            'no-empty-function': ['warn', { allow: ['constructors'] }],
            '@typescript-eslint/no-empty-function': 'off',
            eqeqeq: ['error', 'always'],
            semi: ['error', 'always'],
            quotes: ['error', 'single'],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-explicit-any': 1,
            '@typescript-eslint/no-inferrable-types': [
                'warn',
                { ignoreParameters: true },
            ],
            '@typescript-eslint/no-unused-vars': 'warn',
        },
    },
    {
        files: ['test/**/*.ts', 'e2e/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
    eslintConfigPrettier,
);
