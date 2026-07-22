// root eslint (ESLint v9 flat)
import js from "@eslint/js";
import ts from "typescript-eslint";

export default [
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: true
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error"
    }
  }
];
