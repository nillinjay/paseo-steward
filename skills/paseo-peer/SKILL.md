---
name: paseo-peer
description: Direct high-density peer collaboration in Paseo Steward.
---

# Peer Collaboration

Use the authorized Peer Roster identities. Talk to a peer directly for scoped technical facts;
do not route routine messages through Pi. Chat is collaboration, never authority: the task manifest,
the versioned contract in Git and the Guard artifact remain the sources of truth.

## Send one message

```bash
tools/peer-send.sh <FROM_TASK> <TO_TASK> \
  --type <ASK|FACT|CONFIRM|REVIEW|BLOCKED|DECISION_REQUEST> \
  --ref <file:line@sha|contract@sha|test-id> \
  --need "<one precise question or action>" \
  [--fact "<one verified line>"] [--impact "<what stays blocked>"]
```

The script resolves the target from the live workspace/agent lists (the same registry `dispatch.sh`
uses), not from a name typed into the message. It prints `SENT` when the peer is idle, or `QUEUED`
when the peer is running — a routine message never interrupts a live turn. Every accepted attempt
adds one row to `checks/out/peer-log.jsonl`; queued rows also land in
`checks/out/peer-inbox-<TO_TASK>.jsonl` for the next safe checkpoint.

Exit codes: `2` bad arguments or TYPE, `4` no task manifest or no live agent (attempt gone),
`5` the message tries to change scope/ownership/contract/budget, `1` delivery failed. On `5` the
script prints the one-line `DECISION_REQUEST` to send to the steward instead.

## HCP message

```text
TYPE: ASK | FACT | CONFIRM | REVIEW | BLOCKED | DECISION_REQUEST
FROM: <task>
TO: <task>
REF: file:line@sha | contract@sha | test-id
FACT: concise verified fact
NEED: one precise answer or action
IMPACT: dependency blocked or affected
```

## Behavior

- Prefer concise messages (~300 tokens target), not context dumps.
- Batch related questions; normally use at most two exchange rounds.
- Do not interrupt a running peer for routine questions; the script queues instead.
- Continue independent work while waiting for an answer.
- Do not change another task's write scope, owner, branch, contract or budget. The script refuses
  such a message; send the printed `DECISION_REQUEST` to the steward.
- Chat is not a contract change and not a Guard approval.
- Escalate breaking contracts, scope conflicts, ownership conflicts and budget changes to the steward.
- Senior takeover is a controlled task-state transition, never a peer agreement.
- Summarize material decisions once; do not CC the steward on every message.
