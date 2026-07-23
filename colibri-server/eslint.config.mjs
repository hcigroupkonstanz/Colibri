import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from '@angular-eslint/eslint-plugin';
import globals from 'globals';

export default tseslint.config(
    {
        ignores: [
            '.angular/**',
            'node_modules/**',
            'dist/**',
            'public/**',
            'coverage/**',
            '**/*.d.ts',
            'src/public/**',
            'src/types/**',
            'src/server/modules/networking/message.ts',
            'publish.js',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            '@angular-eslint': angular,
        },
        languageOptions: {
            globals: globals.node,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
        },
        rules: {
            '@angular-eslint/component-selector': ['error', {
                prefix: 'app',
                style: 'kebab-case',
                type: 'element',
            }],
            '@angular-eslint/directive-selector': ['error', {
                prefix: 'app',
                style: 'camelCase',
                type: 'attribute',
            }],
            '@angular-eslint/no-empty-lifecycle-method': 'off',
            'no-useless-constructor': 'off',
            'no-empty-function': ['warn', { allow: ['constructors'] }],
            '@typescript-eslint/no-empty-function': 'off',
            'func-style': ['error', 'expression', { allowArrowFunctions: false }],
            'eqeqeq': ['error', 'always'],
            'semi': ['error', 'always'],
            'quotes': ['error', 'single'],
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-inferrable-types': ['warn', { ignoreParameters: true }],
            '@typescript-eslint/no-unused-vars': 'warn',
        },
    },
);
