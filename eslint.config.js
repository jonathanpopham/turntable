// Two rules only: the async mistakes the strict compiler cannot catch.
// Everything else is tsc's job (same philosophy as Railway's own SDK,
// which ships no lint config at all).
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/"] },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
