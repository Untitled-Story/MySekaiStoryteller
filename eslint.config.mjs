import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'

export default tseslint.config([
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      'src/renderer/public/live2d.min.js',
      'src/renderer/public/live2dcubismcore.min.js'
    ]
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
])
