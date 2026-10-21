# Command ledger (template)

The live state of the project: what may be dispatched next, what is blocked, and who owns each decision.

## Ready queue (what may be dispatched next, in order)

**Three items, not ten.** Completed rows are deleted, not kept.

| # | task | role | depends on |
|---|---|---|---|
| 1 | **T-001 — first leg** | `junior-a` | — |
| 2 | T-002 — second leg | `senior-sol` | T-001 merged |

## Only the owner may decide these four

1. widening authorization beyond the standing grant
2. changing the meaning of a criterion
3. adding, removing or retiring a work item
4. changing what the project is allowed to do

## Unattended operation

- **auto-accept** decides the verdict on work already dispatched; the next step stays a human decision.
- **lazy mode** additionally plans and keeps the project moving. It requires auto-accept.
- The reviewer's model family must differ from the author's.
