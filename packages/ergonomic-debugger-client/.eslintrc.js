module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier', 'chai-friendly'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  rules: {
    'prettier/prettier': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-unused-expressions': 'off',
    'chai-friendly/no-unused-expressions': 'error',
    // Add any project-specific ESLint rules here
    // For example:
    // '@typescript-eslint/no-explicit-any': 'warn',
    // '@typescript-eslint/explicit-module-boundary-types': 'off',
  },
  ignorePatterns: ['.eslintrc.js'], // Add this line
  env: {
    node: true,
    es2022: true, // Aligns with tsconfig.json target
    mocha: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: './tsconfig.eslint.json',
  },
};
