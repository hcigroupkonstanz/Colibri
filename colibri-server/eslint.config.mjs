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
            'publish.mjs',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    // The typed blocks sit before the main rules block on purpose. After it, recommendedTypeChecked would
    // turn no-explicit-any and no-unused-vars from warn back into error, and disableTypeChecked would
    // switch naming-convention off for the environments.
    {
        files: ['src/**/*.ts'],
        extends: tseslint.configs.recommendedTypeChecked,
        rules: {
            '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit' }],
        },
    },
    {
        files: ['src/server/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    // The UI's tsconfigs are not named tsconfig.json, so the project service does not find them;
    // project lists them.
    {
        files: ['src/ui/**/*.ts'],
        ignores: ['src/ui/environments/**'],
        languageOptions: {
            parserOptions: {
                projectService: false,
                project: ['src/ui/tsconfig.app.json', 'src/ui/tsconfig.spec.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    // Angular swaps environment.prod.ts in through fileReplacements, so neither UI tsconfig includes it: typed rules off.
    {
        files: ['src/ui/environments/**'],
        extends: [tseslint.configs.disableTypeChecked],
    },
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
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'separate-type-imports' }],
            '@typescript-eslint/naming-convention': ['error',
                { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
                { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'UPPER_CASE', 'PascalCase'], leadingUnderscore: 'allowDouble' },
                { selector: 'typeLike', format: ['PascalCase'] },
                { selector: 'enumMember', format: ['PascalCase', 'UPPER_CASE'] },
                // Constants a template reads, and static members such as Service.Current.
                { selector: 'classProperty', modifiers: ['readonly'], format: ['camelCase', 'UPPER_CASE', 'PascalCase'], leadingUnderscore: 'allow' },
                // Wire formats, headers and settings keep the names they have outside this code.
                { selector: ['objectLiteralProperty', 'typeProperty', 'import'], format: null },
            ],
        },
    },
    // Size guides from docs/dev/conventions.md.
    {
        files: ['src/**/*.ts'],
        ignores: ['**/*.spec.ts', 'src/ui/testing/**'],
        rules: {
            'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
            'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
            'complexity': ['error', 15],
            'max-depth': ['error', 4],
            'max-params': ['error', 5],
        },
    },
);
