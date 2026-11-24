import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/', 'dist/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['src/main/**', 'src/preload/**', 'scripts/**', '*.config.*'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/overlay/**', 'src/library/**', 'src/recorder/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/extension/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
)
