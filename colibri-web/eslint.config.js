import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nPlugin from 'eslint-plugin-n';
import promisePlugin from 'eslint-plugin-promise';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

export default tseslint.config(
    {
        ignores: ['dist/**', 'coverage/**', 'node_modules/**']
    },
    js.configs.recommended,
    nPlugin.configs['flat/recommended-module'],
    promisePlugin.configs['flat/recommended'],
    {
        // plain JS files (this config, the plain-JavaScript test) run on Node, and unlike
        // the .ts files they are not covered by typescript-eslint's no-undef opt-out
        files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
        languageOptions: {
            globals: {
                console: 'readonly',
                process: 'readonly'
            }
        }
    },
    {
        rules: {
            'no-useless-constructor': 'off',
            'no-empty-function': ['warn', { allow: ['constructors'] }],
            eqeqeq: ['error', 'always']
        }
    },
    {
        // type-aware linting only applies to .ts files, in line with tsconfig.json's
        // `include`; plain JS files above get non-type-checked linting instead
        files: ['**/*.ts'],
        extends: [...tseslint.configs.strictTypeChecked],
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.config.ts']
                },
                tsconfigRootDir
            }
        },
        rules: {
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/no-explicit-any': 1,
            '@typescript-eslint/no-inferrable-types': ['warn', { ignoreParameters: true }],
            '@typescript-eslint/no-unused-vars': 'warn',
            // TS/bundler module resolution already validates import specifiers
            // (see tsconfig.json's moduleResolution: "bundler"); n's resolver
            // doesn't understand extensionless TS imports and reports false positives
            'n/no-missing-import': 'off',
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
            // global fetch has shipped unflagged since Node 18; the rule's builtin
            // version data still marks it experimental until Node 21
            'n/no-unsupported-features/node-builtins': ['error', { ignores: ['fetch'] }],
            '@typescript-eslint/no-invalid-void-type': ['error', { allowAsThisParameter: true }]
        }
    },
    {
        files: ['test/**/*.ts', 'e2e/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off'
        }
    },
    {
        // interactive CLI demos: an explicit exit on user command is the point,
        // not a library abruptly killing its host process
        files: ['samples/**'],
        rules: {
            'n/no-process-exit': 'off'
        }
    },
    {
        files: ['src/**/*.ts'],
        rules: {
            '@typescript-eslint/naming-convention': [
                'error',
                { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
                { selector: 'function', format: ['camelCase', 'PascalCase'] },
                {
                    selector: 'variable',
                    modifiers: ['const'],
                    format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
                    leadingUnderscore: 'allowDouble'
                },
                { selector: 'typeLike', format: ['PascalCase'] },
                { selector: 'enumMember', format: ['PascalCase', 'UPPER_CASE'] },
                {
                    selector: 'classProperty',
                    modifiers: ['private'],
                    format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
                    leadingUnderscore: 'allowDouble'
                },
                {
                    selector: 'classProperty',
                    modifiers: ['readonly'],
                    format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
                    leadingUnderscore: 'allow'
                },
                { selector: ['objectLiteralProperty', 'typeProperty', 'import'], format: null }
            ],
            '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit' }]
        }
    },
    {
        files: ['**/*.ts'],
        rules: {
            '@typescript-eslint/consistent-type-imports': [
                'error',
                { prefer: 'type-imports', fixStyle: 'separate-type-imports' }
            ]
        }
    },
    // Size guides from docs/dev/conventions.md. Warnings until the refactor brings the code under them.
    {
        files: ['src/**/*.ts'],
        rules: {
            'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': ['warn', { max: 40, skipBlankLines: true, skipComments: true }],
            complexity: ['warn', 15],
            'max-depth': ['warn', 4],
            'max-params': ['warn', 5]
        }
    },
    // must stay last: turns off every formatting rule Prettier now owns
    eslintConfigPrettier
);
