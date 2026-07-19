#!/usr/bin/env bash
# The gate. Local green must equal CI green: CI calls this same script.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n=== %s ===\n' "$1"; }

step "typecheck"
npx tsc --noEmit

step "build"
npx tsc -p tsconfig.build.json

step "lint (typed async rules)"
npx eslint .

step "test"
npx vitest run

step "runtime deps are justified"
# Policy: dependencies are welcome when they earn their place. Every runtime
# dependency must be named in the README Dependencies section with a reason,
# or the gate fails. Zero deps passes trivially.
UNJUSTIFIED=$(node -e '
  const { readFileSync } = require("node:fs");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const readme = readFileSync("README.md", "utf8");
  const missing = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!readme.includes("`" + name + "`")) missing.push(name);
  }
  console.log(missing.join(" "));
')
if [ -n "$UNJUSTIFIED" ]; then
  echo "FAIL: runtime dependencies without a README justification: $UNJUSTIFIED" >&2
  exit 1
fi

step "env file is ignored"
if ! git check-ignore -q .env; then
  echo "FAIL: .env is not gitignored" >&2
  exit 1
fi

step "secret scan"
if grep -rnE "(RAILWAY_(API_)?TOKEN=[^\"< ]{8,}|APP_PASSWORD=[^\"< ]{8,})" \
  --include="*.ts" --include="*.md" --include="*.json" --include="*.yml" --include="*.sh" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git . | grep -v ".env.example"; then
  echo "FAIL: possible committed credential" >&2
  exit 1
fi

echo
echo "PASS: all gate steps green"
