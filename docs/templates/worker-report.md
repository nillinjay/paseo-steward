# Worker report — canonical four-field template

> Source: `DESIGN-V2.md` §8 and §15.3. Every worker → steward message is these four fields, nothing else.
> `status` is exactly one of the five terminal outcomes below.

```yaml
status: DONE                  # terminal outcome; exactly one of the five lines below
                              # DONE — delivery: integrated_sha + evidence + task_id
                              # NO-ANOMALY — analysis: the check ran and found no anomaly; a valid result
                              # CLOSED-DISCARDED — information: the legal answer is "this road is closed"; nothing to merge
                              # SOURCE_UNAVAILABLE — external party missed expires_at; closed automatically, not BLOCKED
                              # EXTERNAL_ACCEPTANCE — audit/compliance: an external credential defines DONE; the steward checks hash and reference only
commit_sha: "<sha | ->"
artifact_path: "<repo-relative path | ->"
error: "error_code=<CODE>; first_root_cause=<one deterministic cause>; log_path=<path>"
```

## Rules

- **No narrative.** No "what I did", no transcript, no repeated log.
- **The brief_kind chooses the outcome.** A `delivery` leg that is finished is `DONE`; an `analysis` leg
  that found nothing is `NO-ANOMALY`; an `information` leg whose answer is "do not build it" is
  `CLOSED-DISCARDED`; an external leg past `expires_at` is `SOURCE_UNAVAILABLE`; an `audit` leg whose
  credential decides acceptance is `EXTERNAL_ACCEPTANCE`.
- `DONE` requires `commit_sha` and `artifact_path`; a missing one is not `DONE`. `NO-ANOMALY` and
  `CLOSED-DISCARDED` may use `commit_sha: -`, because the outcome is the finding, not a merge.
- `SOURCE_UNAVAILABLE` is written by the steward when `expires_at` passes; the worker does not guess it.
  `EXTERNAL_ACCEPTANCE` requires the external credential's hash and reference in `artifact_path`; the
  steward checks the hash and the reference, not the external conclusion.
- **`BLOCKED` and `FAILED` are non-terminal.** A run that cannot reach any terminal outcome reports one of
  them with the fourth field, and the steward retries or re-scopes. They are not members of the five.
- `status: BLOCKED` must also name `blocked_on=<one of the four owner-only classes>` in the fourth field.
  `first_root_cause` is the first deterministic cause, not the last symptom. `log_path` is a path, not
  pasted text.
- The steward re-runs the declared acceptance before accepting. "The worker said DONE" is not DONE.
- **Deliverable exemption.** The document the owner asked for is written in full at `artifact_path`; only
  the coordination report is four fields.
