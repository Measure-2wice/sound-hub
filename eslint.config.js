// root eslint (ESLint v9 flat)
import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import ts from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      // The web app builds dev output into `.next-dev` to keep it isolated
      // from `.next` build output. Both are generated and gitignored.
      "**/.next-dev/**",
      "**/node_modules/**",
      "packages/db/src/generated/**",
      "apps/web/next-env.d.ts",
      "**/*.js",
      "**/*.mjs",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    plugins: {
      "@next/next": next,
    },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off",
    },
    settings: {
      next: {
        rootDir: "apps/web",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "packages/db/prisma.config.ts",
            "packages/db/prisma/seed.test.ts",
            "packages/db/prisma/snapshot-probe.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
];
