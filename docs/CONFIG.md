# Configuration reference

All settings live in one file: `config.json` in the coordinator home folder.

The home folder is `~/.claude-coordinator`. To use another folder, set the environment variable `COORDINATOR_BAND_HOME`.

```
~/.claude-coordinator/
  config.json            your settings (you edit this)
  overrides/<name>.json  optional hand-written lanes and needs
  data/<name>.json       what the last refresh found (the program writes this)
  logs/refresh.log       one line per refresh
```

The file has a version number. If your file is older or newer than the program, the coordinator tells you which file, which versions, and what to run.

## Top level

| Key | Meaning | Default |
| --- | --- | --- |
| `configVersion` | Must be `1`. | required |
| `refresh.mode` | `auto`: use a fresh data file if there is one, else fetch inside Claude Code. `self`: always fetch inside Claude Code. `file`: only read the data file. | `auto` |
| `refresh.intervalMinutes` | How often to fetch. | `5` |
| `refresh.staleAfterMinutes` | A section shows `stale` after this long without a good fetch. | `30` |
| `minMoving` | Show a hint when fewer lanes than this are moving. `0` turns the hint off. | `3` |
| `stages` | The pipeline stages. See below. | plan, build, verify, review, merge-line, merged |
| `statusColors` | Colour of the dot for `moving`, `waiting`, `blocked`, `done`. | green, yellow, red, gray |
| `profiles` | One entry per view (for example one per project). | required |

Colours: `green`, `yellow`, `red`, `cyan`, `blue`, `magenta`, `gray`, `white`. The default stages use one ramp from violet through blue and teal to green (plan to merged), with lightness rising so neighbours differ for colour-blind viewers. A stage colour can also be a hex value such as `#3fa7d6`.

## Stages and words

A stage has an `id`, a `label` (shown), a `description` (shown after the lane's stage) and a `color`.
The strip draws one block per stage, in list order. The last stage counts as done.

```json
"stages": [
  { "id": "idea",    "label": "idea",    "description": "just an idea",       "color": "gray" },
  { "id": "doing",   "label": "doing",   "description": "someone is on it",   "color": "green" },
  { "id": "shipped", "label": "shipped", "description": "out the door",       "color": "cyan" }
]
```

If you change the stage ids, also change `rules` (below), because each rule names a stage id.

## Profiles

```json
"profiles": {
  "main": {
    "title": "My project",
    "match": { "always": true },
    "sources": [ ... ],
    "mergeLine": { ... },
    "codexCloud": { "enabled": false },
    "services": [ ... ]
  }
}
```

### Which session shows which profile

| `match` | The profile shows when |
| --- | --- |
| `{ "always": true }` | in every session |
| `{ "cwdContains": ["my-repo"] }` | the session's folder path contains the text |
| `{ "sessions": ["<session id>"] }` | the session id is listed |
| (left out) | only when it is the one profile in the file, or after `/coordinator on <name>` |

### Sources

A source brings in lanes. You can list several. Lanes with the same `ref` (for example `app#12`) join into one lane. A later source overrides the fields of an earlier one, except the `state` text, where the first source with text wins.

**`github`** (reads pull requests with the `gh` tool)

| Key | Meaning |
| --- | --- |
| `owner`, `repos` | Where to look. |
| `label` | Every open pull request with this label becomes a lane. |
| `author` | Use `"@me"` to list only your own pull requests. Use it when you do not use a label. |
| `limit` | Most pull requests per repo. Default 30. |
| `needsLabel` | Open issues and pull requests with this label go under NEEDS YOU. Default `needs-me`. |
| `rules` | Replace the default stage rules. See below. |

**`file`** (hand-written lanes and needs)

```json
{ "type": "file", "path": "overrides/main.json" }
```

A relative path starts in the coordinator home folder. See `examples/overrides.example.json`.
Set `"lanes": false` to read only the needs from the file.
Put `"updated": "<ISO time>"` at the top of the file and update it whenever you edit the lanes. The LANES header then shows how old your hand-written data is (`stale: data 8h old`). Without it the coordinator cannot know.
If a lane names a pull request (`ref`: `repo#12`) and that repo is listed in the github source, the coordinator asks GitHub about it each refresh. A merged pull request becomes a done lane. A closed one is dropped.
Use this only to add what GitHub cannot know, or to correct a lane. A lane with the same `ref` as a GitHub lane keeps its live `state` text, and takes your `stage`, `status` and `blockedBy`.

**`command`** (any program)

```json
{ "type": "command", "argv": ["node", "my-source.mjs"], "timeoutSeconds": 30 }
```

The program prints JSON on standard output. See `docs/SOURCES.md`.

### Next, flow, campaigns, dependencies

| Setting | Where | What it does |
| --- | --- | --- |
| `stuckHours` | top level | Hours in one stage before a lane counts as stuck. Default 24. |
| `campaignPrefix` | github source | A label starting with this names the campaign. Default `campaign:`. A milestone is used when no label fits. |
| `sessions.dir` | profile | The folder where the Claude desktop app keeps its session records. Turns the **Ask** button into "ask its session". Read-only. The record format is the app's own and can change. |

The `github` source also reads reviewers, the description and the milestone. All of it comes back in the same `gh pr list` call. Only merged pull requests need another call: one `gh pr list --state merged` per repository, at most once an hour.

A pull request description that says `depends on #12` or `blocked by #12` makes a dependency. `coordinator graph` prints the lanes and their dependencies as Mermaid text.

### Stage rules

Every lane from the `github` source gets its stage and status from the first rule that matches. The default list is:

| When | Stage | Status | Reason shown |
| --- | --- | --- | --- |
| merged | merged | done | |
| a plan (see below) | plan | blocked, moving or waiting | failing checks, changes requested, or "plan in review"; with auto-merge on it goes to merge-line |
| draft | build | moving | |
| a check failed | review | blocked | N check(s) failing |
| changes requested | review | blocked | changes requested |
| auto-merge is on | merge-line | moving | |
| checks are running | verify | moving | |
| approved | merge-line | waiting | ready to merge |
| anything else | review | waiting | awaiting review |

A pull request is a **plan** when every changed file sits under `planPaths` (default `wiki/plans/`, `wiki/decisions/`, `docs/plans/`, `docs/decisions/`) or its title matches `planTitle` (default: starts with `plan:`, `plan(scope):` or `docs(plans)`). Set either on the `github` source. The file list comes back in the same `gh pr list` call, so plans cost no extra request. In your own rules, `plan: true` matches these pull requests.

To replace it, set `rules` on the source. A rule is `{ "when": { ... }, "stage": "...", "status": "...", "blockedBy": "..." }`. `when` can use `draft`, `failing`, `pending`, `changesRequested`, `approved`, `autoMerge`, `merged`, `closed`, `plan` (each `true` or `false`) and `label` (a label name). An empty `when` matches everything, so put it last. `blockedBy` may contain `{failing}` or `{pending}`, which become counts.

```json
"rules": [
  { "when": { "label": "on-hold" }, "stage": "review", "status": "blocked", "blockedBy": "on hold" },
  { "when": { "draft": true },     "stage": "build",  "status": "moving" },
  { "when": {},                    "stage": "review", "status": "waiting", "blockedBy": "awaiting review" }
]
```

### Merge line (optional)

A merge line is a queue of pull requests that merge one at a time. The coordinator does not know how your queue works. You give it a program that prints the queue.

```json
"mergeLine": { "command": ["my-queue-tool", "status"], "cwd": "/path/to/repo", "ttlMinutes": 30, "repo": "app" }
```

The program must print `Head: #123` (the next to merge) and one `PR #124: note` line per waiting pull request. The note starts with `behind head`, `held`, `draft`, or free text. The section shows `Head #none` when there is no head.
`file` is a JSON snapshot of the line that another tool keeps up to date (`generated_at`, `head`, `prs` with `number`, `set`, `blocker`, `owner`, `reason`). The coordinator reads it on every pass, with no ttl and no GitHub calls, and uses it while it is younger than `maxAgeMinutes` (default 15). The section's age is the snapshot's own `generated_at`. When the file is missing, stale or unreadable, the coordinator runs `command` as below, and a failure names both reasons.

The command can be slow. The coordinator runs it at most once per `ttlMinutes` (default 30) and keeps the last good result if a run fails. After a failure it waits twice as long for each failure in a row, up to 60 minutes, and a rate-limit error waits at least 30. `coordinator refresh --force-merge-line` skips the wait. A status command that calls the GitHub API can cost hundreds of calls per run, so do not lower the ttl without a reason.

### Codex Cloud (optional)

```json
"codexCloud": { "enabled": true }
```

Shows tasks from `codex cloud list`. Off by default. A lane can show its task if the lane has `"codex": "<task id>"` (set in an override file).

### Services (optional, off unless you list them)

```json
"services": [ { "name": "api", "url": "http://127.0.0.1:3000/health" } ]
```

The coordinator sends one GET request to each URL once a minute and shows up or down. It only accepts addresses on your own machine or private network (`localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `*.local`). To check another address, add `"allowRemote": true` to that entry. A page with a self-signed certificate shows as down. Use `http://` for local checks.
