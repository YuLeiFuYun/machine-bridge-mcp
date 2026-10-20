import globals from "globals";

// Scope contract: every runtime source file is covered by one of the blocks below, and
// `tests/lint-gate-test.mjs` fails if that stops being true. `src/worker/**/*.ts` is the one
// documented exception — eslint 10 has no TypeScript parser that accepts typescript 7, so the
// Worker is gated by `tsc -p tsconfig.json` (strict, noUnusedLocals, noUnusedParameters,
// noFallthroughCasesInSwitch, noImplicitReturns) instead of by these rules.
const correctnessRules = {
  "no-undef": "error",
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-async-promise-executor": "error",
  "no-promise-executor-return": "error",
  "no-unsafe-finally": "error",
  "no-self-assign": "error",
  "no-useless-catch": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  "no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
    ignoreRestSiblings: true,
  }],
};

export default [
  {
    ignores: ["node_modules/**", ".wrangler/**"],
  },
  {
    files: ["eslint.config.mjs", "bin/**/*.mjs", "src/local/**/*.{js,mjs}", "src/shared/**/*.{js,mjs}", "scripts/**/*.{js,mjs}", ".github/scripts/**/*.{js,mjs}", "tests/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.sharedNodeBrowser,
      },
    },
    rules: correctnessRules,
  },
  {
    files: ["src/local/**/*.{js,mjs}", "src/shared/**/*.{js,mjs}", "scripts/**/*.{js,mjs}", ".github/scripts/**/*.{js,mjs}"],
    rules: {
      "complexity": ["error", 45],
      "max-lines-per-function": ["error", { max: 180, skipBlankLines: true, skipComments: true, IIFEs: true }],
    },
  },
  {
    files: ["browser-extension/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        importScripts: "readonly",
      },
    },
    rules: correctnessRules,
  },
];
