import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint flat config.
 *
 * Block 1 — react-hooks rules across the whole renderer (catches dependency
 * array bugs + rules-of-hooks violations).
 *
 * Block 2 — primitives adoption gate scoped to src/renderer/modules:
 * bare <button>/<input>/<select>/<textarea> are forbidden so the Sprint 2
 * migration (audit doc .design-audit/PRIMITIVES-AUDIT.md) does not regress.
 * Components (which legitimately render bare HTML) and the shell App.tsx
 * are intentionally outside this gate.
 */

const baseLanguageOptions = {
  parser: tsParser,
  ecmaVersion: 'latest',
  sourceType: 'module',
  parserOptions: {
    ecmaFeatures: { jsx: true },
  },
};

export default [
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: baseLanguageOptions,
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['src/renderer/modules/**/*.{ts,tsx}'],
    languageOptions: baseLanguageOptions,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXOpeningElement[name.name='button']",
          message:
            'Use <Button> from "../components" (variants: primary|secondary|ghost|danger|icon, sizes: sm|md|lg). Bare <button> is forbidden in modules to keep the design system consistent. See .design-audit/PRIMITIVES-AUDIT.md.',
        },
        {
          selector: "JSXOpeningElement[name.name='input']",
          message:
            'Use <Field> (or <Toggle> for checkbox) from "../components" instead of bare <input>. See .design-audit/PRIMITIVES-AUDIT.md.',
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message:
            'Use <Select> from "../components" instead of bare <select>. See .design-audit/PRIMITIVES-AUDIT.md.',
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message:
            'Use <Textarea> from "../components" instead of bare <textarea>. See .design-audit/PRIMITIVES-AUDIT.md.',
        },
      ],
    },
  },
];
