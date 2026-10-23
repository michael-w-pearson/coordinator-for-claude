---
status: accepted
owner: michael
related: [2026-10-22-public-rework.md]
---

# Band 1.1: eight features

## Status
Accepted by Michael, 2026-10-23. Not built: idea 8 (time travel) and idea 10 (shareable snapshot).

## Context
The band shows lanes by stage. Michael asked for: a next-action line, flow view, dependency graph, campaigns, click to act, alerts, a why-is-it-stuck explainer, compact and focus modes.

## Decision
Data first, view second. Every item uses data the existing calls already return. No new GitHub calls and no LLM.

1. **Lane facts** (`since`, `checks`, `waitingOn`, `dependsOn`, `campaign`). `gh pr list` already returns checks. Add `reviewRequests`, `milestone` and `body` to the same call. `since` (time in stage) is kept from the previous data, so it costs no request.
2. **Flow log** in the data file: merged timestamps and per-stage durations, capped. Gives throughput per day and median time per stage.
3. **Next action**: a rule-built line at the top (answer a question, merge the head, fix the blocked lane).
4. **Campaigns**: group by label prefix `campaign:` or by milestone. One progress bar per group.
5. **Dependencies**: parse "depends on #N" and "blocked by #N". Pane shows a tree. `band graph` prints Mermaid.
6. **Why stuck**: an expanded lane lists failing check names and who is asked to review. Log lines need a call per PR, so they are not fetched.
7. **Click to act**: a lane button "Ask Claude" sends a ready-made prompt to Claude in this session. The mod API has no call to open another session. A lane may carry a `sessionLink` from its source, shown as a link.
8. **Alerts**: toast and status line only on a change: a lane turns blocked, a lane is stuck over N hours, the queue head changes. Each alert fires once.
9. **Compact and focus modes**: toggles in the pane, kept in the store. Focus shows lanes for the session's repo.

## Consequences
Data file gets optional fields. `dataVersion` stays 1. The mod API cannot switch sessions, so click-to-act sends a prompt and does not move the view.
