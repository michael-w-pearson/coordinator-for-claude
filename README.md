# Claude Coordinator

**See what your team's work is doing, at a glance, inside Claude Code.**

A live panel for [Claude Code](https://claude.com/claude-code) that turns your open pull requests into lanes on a pipeline: `plan → build → verify → review → merge-line → merged`. It tells you what is moving, what is stuck and why, and what to do next. It reads GitHub, and it costs **no model tokens**.

![license MIT](https://img.shields.io/badge/license-MIT-blue) ![node 22.18+](https://img.shields.io/badge/node-22.18%2B-green) ![no LLM tokens](https://img.shields.io/badge/LLM%20tokens-0-brightgreen)

## Why

When several people, or several Claude sessions, work at once, the hard part is not writing the code. It is knowing which pull request is waiting on whom, which one has failing checks, and which one nobody has touched for a day. GitHub shows a list. This shows a **pipeline**, and it keeps itself up to date beside your chat.

## What you get

- **A Next line.** One sentence at the top: "Merge #42", "Unblock: the login fix (2 checks failing)", "Nudge: the docs PR has sat in review for 30h". Plain rules, no model.
- **Lanes by stage.** Every open pull request with your label becomes a lane. Six distinct colours run from violet (plan) to green (merged), so the stage reads at a glance and works for colour-blind viewers. Plans (docs-only changes) sit in their own stage before build.
- **Why it is stuck.** Failing check names, who is asked to review, what it waits on, and how long it has been in the stage.
- **Flow numbers.** Merged per day as a sparkline, and the median time work spends in each stage.
- **Campaigns and dependencies.** Group lanes by a `campaign:` label or milestone. "Depends on #12" in a description draws a dependency tree, and `coordinator graph` prints it as a Mermaid diagram you can paste into a document.
- **Alerts that earn attention.** A toast, once, when a lane turns blocked, gets stuck, or the merge queue head changes.
- **Ask Claude.** A button on blocked lanes sends a ready-made prompt to Claude, or to the session that owns the pull request.
- **Compact and Focus views** for narrow panes and for the repository you are in.
- **Honest ages.** Every section says how old its data is. A failed fetch never blanks a panel: the last good data stays, with its age and the reason.
- **Any source.** GitHub is built in. A tiny `command` source lets any program add lanes: GitLab, Linear, Jira, CI.

## What it looks like

```
┌─ N E X T    ─────────────────────────────────────────────────────────┐
│ Answer: gh auth login --with-token accepts a token without the advertised workflow scope
└──────────────────────────────────────────────────────────────────────┘
┌─ N E E D S   Y O U   20 · ok · now ──────────────────────────────────┐
│ ● gh auth login --with-token accepts a to… 19h
│ ● `gh issue create --type` creates the is… 19h
│ ● `gh skill update` help incorrectly prom… 19h
│ ● gh pr close <URL> --delete-branch can f… 19h
│ ● `gh pr merge <url> --delete-branch` rem… 19h
│ ● `gh release create` does not recognise … 19h
│ ● `gh issue create` issue type supports o… 19h
│ ● gh pr close --comment silently discards… 19h
│ … and 12 more
└──────────────────────────────────────────────────────────────────────┘
┌─ L A N E S   1/2 moving · ok · now ──────────────────────────────────┐
│ 1 of 5 moving                                      4 waiting  0 done
│ ████████████████████████████████████████████████████████████████████
│ ■ plan                                                       0    0%
│ ■ build                                                      1   20%
│ ■ verify                                                     0    0%
│ ■ review                                                     4   80%
│ ■ merge-line                                                 0    0%
│ ■ merged                                                     0    0%
│
│ ● release download: add --verify to… draft, blocked idle 1d
│   ▰▰▱▱▱▱ build · being written
│ ● fix(issue create): resolve --type… ready, blocked
│   ▰▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│   ⏳ @tidy-dev, @BagToad
│ ● docs(skills): clarify that skill … ready, blocked
│   ▰▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│   ⏳ @niik
│ ● docs(skills): add task triggers a… ready, blocked
│   ▰▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│   ⏳ @sergiou87
│ ● docs: Add step to install working… ready, blocked
│   ▰▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│   ⏳ @sergiou87, @babakks
│ Merged per day ▁▁▁▁█▁▁  1 in 7d
│ Below 2 moving. No waiting lane to start.   [Refresh]
└──────────────────────────────────────────────────────────────────────┘
```

The capture is real output of `coordinator show` on a public repository (`cli/cli`, lanes from the label `external`, needs from the label `bug`). It is the same text the pane draws. In Claude Code the pane adds colour, a thin stacked bar, and clickable buttons.

## Install

You need Claude Code and the GitHub tool [`gh`](https://cli.github.com) signed in (`gh auth login`).

```
/plugin install coordinator-for-claude --marketplace michael-w-pearson/coordinator-for-claude
```

Answer `y` to add the marketplace, then choose a scope.

## Set up in two minutes

Inside Claude Code, type:

```
/coordinator init your-github-name/your-repo
```

That writes a starter config and opens the pane. Now add the label `band` to a pull request in that repository. It appears as a lane within five minutes (or type `/coordinator refresh`).

Check that everything works:

```
/coordinator doctor
```

Prefer a terminal? The same steps are a program that needs only Node 22.18 or newer:

```
node bin/coordinator.mjs init --owner your-github-name --repos your-repo
node bin/coordinator.mjs doctor
node bin/coordinator.mjs refresh
node bin/coordinator.mjs show
```

Everything about your setup is one file, `~/.claude-coordinator/config.json`. `docs/CONFIG.md` explains each setting. `examples/` holds a full example.

## How it works

| Part | What it does |
| --- | --- |
| **Sources** | Where lanes come from. `github` is built in. `file` holds hand-written overrides. `command` runs any program that prints JSON, so you can add GitLab, Linear, Jira or CI. See `docs/SOURCES.md`. |
| **Rules** | Turn a pull request's facts (draft, checks, review, auto-merge) into a stage and a status. You can replace the rules. Nothing is typed by hand unless you want it. |
| **Stages** | Names, descriptions and colours are config. |
| **Sections** | Each shows its age and one of four states: `ok`, `stale`, `empty`, or `unavailable: <reason>`. A failed fetch never blanks a section. The last good data stays, with its age. |
| **Refresh** | The pane fetches for itself while Claude Code is open. Optionally an operating-system job keeps the files fresh when it is closed: `coordinator schedule install`. It works on Windows, macOS and Linux. |

Why "no tokens": the coordinator is plain code. Lanes are derived from GitHub fields by rules, not written by a model.

## Commands

In Claude Code: `/coordinator init <owner>/<repo>`, `/coordinator validate`, `/coordinator doctor`, `/coordinator refresh`, `/coordinator on <profile>`, `/pane`.

In a terminal (`node bin/coordinator.mjs ...`, or `band ...` if you install the package): `init`, `validate`, `doctor`, `refresh`, `show`, `graph`, `migrate`, `schedule install|status|uninstall`, `version`.

## Privacy and safety

- Read-only: the coordinator only reads pull requests and issues. It never writes to GitHub.
- It uses your own `gh` sign-in. Use a fine-grained read-only token. No secret goes in the config file.
- It sends nothing to the authors or to any model. Service checks are off unless you list a URL, and only local addresses are accepted unless you allow more.

Details are in `docs/PRIVACY.md`.

## Troubleshooting

Run `coordinator doctor` first. The most common fixes:

| You see | Do this |
| --- | --- |
| `No config yet` | `/coordinator init <owner>/<repo>` |
| `unavailable: ... "gh" is not installed` | Install from https://cli.github.com |
| `unavailable: gh is not signed in` | `gh auth login` in a terminal |
| No lanes | Check the label is on an open pull request: `gh pr list --repo <owner>/<repo> --label band` |
| `run "coordinator migrate"` | An older config file. `coordinator migrate` updates it and keeps a backup. |

More in `docs/TROUBLESHOOTING.md`.

## Roadmap

- History: a "what changed since you last looked" summary and a sparkline of moving lanes over a day.
- A shareable snapshot (HTML or Markdown) of the coordinator for stand-ups.
- More built-in sources (GitLab, Linear) and a source for CI status.
- Colours that follow the light and dark theme exactly.

## Contributing

Run the tests with `claude plugin test .` and `node --test "test-node/*.test.mjs"`. Tests use output recorded from the real `gh` tool (`test/fixtures/`). After you change a fixture run `node scripts/gen-fixtures.mjs`. After you change `src/types.ts` run `node scripts/gen-contract.mjs`. Keep the project free of names, paths and addresses that belong to one person: `node scripts/check-neutral.mjs` checks this.

## Licence

MIT. See `LICENSE`. See `CHANGELOG.md` for what changed.
