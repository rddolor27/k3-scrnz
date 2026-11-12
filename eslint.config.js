import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettierConfig from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
	globalIgnores(['dist/**', 'src-tauri/**', 'docs/**', '.claude/**']),

	js.configs.recommended,
	tseslint.configs.recommended,
	prettierConfig,

	{
		files: ['**/*.{js,mjs,cjs,ts,tsx}'],
		plugins: {
			'unused-imports': unusedImports,
			'simple-import-sort': simpleImportSort,
		},
		rules: {
			'@typescript-eslint/no-unused-vars': 'off',
			'unused-imports/no-unused-imports': 'error',
			'unused-imports/no-unused-vars': 'error',
			'simple-import-sort/imports': 'error',
			'simple-import-sort/exports': 'error',
			'no-trailing-spaces': 'error',
			'eol-last': ['error', 'always'],
		},
	},

	{
		files: ['*.config.{js,ts}'],
		languageOptions: { globals: globals.node },
	},

	{
		files: ['src/**/*.{ts,tsx}'],
		extends: [reactHooks.configs.flat['recommended-latest']],
		languageOptions: { globals: globals.browser },
		rules: {
			'@typescript-eslint/explicit-function-return-type': 'error',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/consistent-type-assertions': [
				'error',
				{ assertionStyle: 'never' },
			],
			'func-style': ['error', 'expression'],
			'no-console': 'error',
			'no-restricted-syntax': [
				'error',
				{
					selector: 'ExportDefaultDeclaration',
					message: 'Use named exports.',
				},
			],
		},
	},
])
