import js from "@eslint/js";
import typescriptEslintPlugin from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/**", "node_modules/**", "coverage/**", ".worktrees/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    plugins: {
      "@typescript-eslint": typescriptEslintPlugin
    },
    rules: {
      ...typescriptEslintPlugin.configs.recommended.rules,
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { "prefer": "type-imports" }]
    }
  }
];
