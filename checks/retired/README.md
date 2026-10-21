# Retired checks

A retired check keeps its file and loses its authority. It is not run by `tools/suite.sh` (`checks/leg*.cjs` only).

## leg26-claim-recovery.cjs (retired 2026-10-20)

It sliced `spawnSteward`'s source text and ran the fragment through `new Function` to assert that a failed spawn
writes `takeoverError` and leaves the poke counter alone. Two things killed it:

1. **It was TypeScript in a JavaScript evaluator.** The fragment contains `error as NodeJS.ErrnoException`; once a
   cast appeared, the check threw `SyntaxError: Unexpected identifier 'as'`.
2. **Source slicing is not a test.** When T-138 added a persisted spawn reservation to the same function, the
   slice no longer matched the code it claimed to test, and the failure it reported was about the harness.

The property it wanted is now covered where it belongs: `checks/leg27-spawn-reservation.cjs` drives real ticks
with a fake `paseo` and asserts that a failed spawn keeps the reservation and that a successful one clears it;
`checks/leg9-lazy.cjs` covers the dispatch failure paths. A behavioural probe beats a text fragment.
