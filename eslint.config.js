'use strict';

const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

const commonRules = {
  'array-callback-return': 'error',
  curly: ['error', 'multi-line'],
  eqeqeq: ['error', 'smart'],
  'no-constant-binary-expression': 'error',
  'no-constructor-return': 'error',
  'no-duplicate-imports': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-promise-executor-return': 'error',
  'no-return-await': 'error',
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable-loop': 'error',
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
  'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
  'require-atomic-updates': 'error',
};

module.exports = [
  {
    ignores: ['data/**', 'node_modules/**', 'runs/**', '**/*.min.*'],
  },
  js.configs.recommended,
  {
    files: [
      'server.js',
      'eslint.config.js',
      'lib/**/*.js',
      'adapters/**/*.js',
      'test/**/*.js',
      'scripts/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: commonRules,
  },
  {
    files: ['public/app.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
    rules: commonRules,
  },
  prettier,
];
