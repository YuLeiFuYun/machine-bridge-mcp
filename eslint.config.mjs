import js from "@eslint/js";
import globals from "globals";

const correctnessRules = {
  "no-undef": "error",
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
};

export default [
  {
    ignores: ["node_modules/**", ".wrangler/**"],
  },
  {
    files: ["eslint.config.mjs", "bin/**/*.mjs", "src/local/**/*.{js,mjs}", "scripts/**/*.{js,mjs}", "tests/**/*.mjs"],
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
