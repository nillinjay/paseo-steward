# Contributing

The project is small enough that one rule explains almost everything:

> **A claim needs a repro, and a fix needs a check.**

Concretely:

1. **Open an issue with the failing input**, not the failing philosophy. "A worker can write outside its worktree via
   `gitdir: /`" beats "the sandbox feels weak".
2. **Every fix lands with a check in `checks/`.** The suite is the contract; a check that cannot fail is decoration.
3. **Run `npx tsc --noEmit` and `./tools/suite.sh` before you open a pull request.** Both must be green.
4. **Do not widen a permission to make a test pass.** If a check needs a wider answer, the check is probably describing
   the wrong behaviour — say so in the pull request instead.
5. **State limitations in `SECURITY.md`**, in plain language, at the time you discover them. A known limit written down
   is worth more than a fix promised later.

House style for code: TypeScript with explicit return types on exported functions, English comments that explain *why*
rather than *what*, no new runtime dependency without a paragraph in the pull request, and no `node:` import in
`shared/` (it is bundled for a runtime that has none).
