import typescriptEslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import pixelAgentsPlugin from './eslint-rules/pixel-agents-rules.mjs';

export default [
  {
    files: ['**/*.ts'],
  },
  {
    plugins: {
      '@typescript-eslint': typescriptEslint.plugin,
      'simple-import-sort': simpleImportSort,
      'pixel-agents': pixelAgentsPlugin,
    },

    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },

    rules: {
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],

      curly: 'error',
      eqeqeq: 'error',
      'no-throw-literal': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'pixel-agents/no-inline-colors': 'error',
    },
  },
  // Layering: client/ (emitter) and server/ (receiver + viewer) never import
  // each other. Only cli/ composes both. Both may import core/.
  {
    files: ['server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/client/src/**', '**/cli/src/**'], message: 'server/ must not import client/ or cli/ (see openspec deployment-modes).' }] },
      ],
    },
  },
  {
    files: ['client/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/server/src/**', '**/cli/src/**'], message: 'client/ must not import server/ or cli/ (see openspec deployment-modes).' }] },
      ],
    },
  },
  {
    files: ['core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/server/src/**', '**/client/src/**', '**/cli/src/**'], message: 'core/ depends on nothing.' }] },
      ],
    },
  },
  eslintConfigPrettier,
];
