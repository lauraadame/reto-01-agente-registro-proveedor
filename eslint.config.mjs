import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', 'reto-01/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.ts'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  { files: ['web/**/*.js'], languageOptions: { globals: { document: 'readonly', fetch: 'readonly' } } }
);
