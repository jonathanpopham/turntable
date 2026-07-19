import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Anchor to the repo's own test directory: agent worktrees live under
    // .claude/worktrees/ and carry their own copies of these files.
    include: ["test/**/*.test.ts"],
    exclude: ["**/.claude/**", "**/node_modules/**", "**/dist/**"],
  },
});
