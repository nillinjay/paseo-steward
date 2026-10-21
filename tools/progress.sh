#!/usr/bin/env bash
# Project progress in the terminal — the same numbers the UI bar will show.
#
# Usage: tools/progress.sh [project-root]     (default: the repo this script lives in)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="${1:-$(pwd)}"
# Bundle both halves: server/progress.ts re-exports only its collectors, so import the pure function from
# shared/progress.ts into the same bundle through a shim.
cat > ./.progress-entry.ts <<'TS'
export { collectProgressInput } from "./server/progress";
export { computeProgress } from "./shared/progress";
TS
npx esbuild ./.progress-entry.ts --bundle --platform=node --format=cjs --outfile=./.progress.cjs --external:@getpaseo/* >/dev/null 2>&1
node - "$ROOT" <<'JS'
const { collectProgressInput, computeProgress } = require("./.progress.cjs");
const root = process.argv[2];
collectProgressInput(root).then((input) => {
  const s = computeProgress(input);
  const width = 28;
  const filled = Math.round((s.percent / 100) * width);
  const bar = "█".repeat(filled) + "·".repeat(width - filled);
  const tilde = s.estimated ? "~" : "";
  const basis = s.basis === "milestones"
    ? `${s.milestones.done}/${s.milestones.total} milestones`
    : `${s.legs.accepted}/${s.legs.accepted + s.legs.open} legs (estimated)`;
  const segs = s.segments.filter((x) => x.count > 0).map((x) => `${x.key}=${x.count}`).join("  ");
  console.log(`${tilde}${s.percent.toFixed(1)}%  [${bar}]`);
  console.log(`basis: ${basis}`);
  console.log(`segments: ${segs || "none"}`);
  const a = s.attention;
  console.log(`attention: blocked=${a.blocked} ownerQuestions=${a.ownerQuestions} staleHours=${a.staleHours ?? "-"}`);
  console.log(`${s.label}`);
}).catch((e) => { console.error("progress:", e.message); process.exit(1); });
JS
rm -f ./.progress.cjs ./.progress-entry.ts
