# coordinator-band

A status band for [Claude Code](https://claude.com/claude-code). It shows your work as **lanes**, so you see at a glance what is moving, what waits, and what needs you.

- Every open pull request with a label (for example `band`) becomes a lane.
- Each lane has a five-block pipeline strip: `build → verify → review → merge-line → merged`, and a plain-English line about the current stage.
- A **NEEDS YOU** section lists the issues and pull requests that wait for you.
- Optional sections: a merge queue, Codex Cloud tasks, local service checks. The merge-queue command can be expensive (hundreds of GitHub calls a run), so it runs at most every 30 minutes and backs off after a failure.
- It never calls a language model. It costs **no tokens**. It reads GitHub with the `gh` tool and sends nothing anywhere else.

```
┌─ N E E D S   Y O U   20 · ok · now ────────────────────────────────────┐
│ ● gh auth login --with-token accepts a to… 15h
│ ● `gh issue create --type` creates the is… 15h
│ ● `gh skill update` help incorrectly prom… 15h
│ ● gh pr close <URL> --delete-branch can f… 15h
│ ● `gh pr merge <url> --delete-branch` rem… 15h
│ ● `gh release create` does not recognise … 15h
│ ● `gh issue create` issue type supports o… 15h
│ ● gh pr close --comment silently discards… 15h
│ … and 12 more
└────────────────────────────────────────────────────────────────────────┘
┌─ L A N E S   1/2 moving · ok · now ────────────────────────────────────┐
│ 1 of 5 moving                                        4 waiting  0 done
│ ██████████████████████████████████████████████████████████████████████
│ ■ build                                                        1   20%
│ ■ verify                                                       0    0%
│ ■ review                                                       4   80%
│ ■ merge-line                                                   0    0%
│ ■ merged                                                       0    0%
│
│ ● release download: add --verify to… draft, blocked idle 1d
│   ▰▱▱▱▱ build · being written
│ ● fix(issue create): resolve --type… ready, blocked
│   ▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│ ● docs(skills): clarify that skill … ready, blocked
│   ▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│ ● docs(skills): add task triggers a… ready, blocked
│   ▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│ ● docs: Add step to install working… ready, blocked
│   ▰▰▰▱▱ review · waiting on a reviewer or a fix
│   ← awaiting review
│ Bar = build → verify → review → merge-line → merged
│ Below 2 moving. No waiting lane to start.   [Refresh]
└────────────────────────────────────────────────────────────────────────┘
```

The capture above is real output of `band show` on a public repository (`cli/cli`, lanes from the label `external`, needs from the label `bug`). It is the same text the pane draws.

The layout follows Claude's own panels: a headline number, a stacked bar, legend rows with a count and a share, a footer with one quiet button, and a status line (`band 3/5 moving · 1 needs you`) that stays visible when the pane is closed.

## Install

You need Claude Code and the GitHub tool [`gh`](https://cli.github.com) signed in (`gh auth login`).

```
/plugin install coordinator-band --marketplace michael-w-pearson/coordinator-band
```

Answer `y` to add the marketplace, then choose a scope.

## Set up in two minutes

Inside Claude Code, type:

```
/band init your-github-name/your-repo
```

That writes a starter config and opens the pane. Now add the label `band` to a pull request in that repository. It appears as a lane within five minutes (or type `/band refresh`).

Check that everything works:

```
/band doctor
```

Prefer a terminal? The same steps are a program that needs only Node 22.18 or newer:

```
node bin/band.mjs init --owner your-github-name --repos your-repo
node bin/band.mjs doctor
node bin/band.mjs refresh
node bin/band.mjs show
```

Everything about your setup is one file, `~/.coordinator-band/config.json`. `docs/CONFIG.md` explains each setting. `examples/` holds a full example.

## How it works

| Part | What it does |
| --- | --- |
| **Sources** | Where lanes come from. `github` is built in. `file` holds hand-written overrides. `command` runs any program that prints JSON, so you can add GitLab, Linear, Jira or CI. See `docs/SOURCES.md`. |
| **Rules** | Turn a pull request's facts (draft, checks, review, auto-merge) into a stage and a status. You can replace the rules. Nothing is typed by hand unless you want it. |
| **Stages** | Names, descriptions and colours are config. |
| **Sections** | Each shows its age and one of four states: `ok`, `stale`, `empty`, or `unavailable: <reason>`. A failed fetch never blanks a section. The last good data stays, with its age. |
| **Refresh** | The pane fetches for itself while Claude Code is open. Optionally an operating-system job keeps the files fresh when it is closed: `band schedule install`. It works on Windows, macOS and Linux. |

Why "no tokens": the band is plain code. Lanes are derived from GitHub fields by rules, not written by a model.

## Commands

In Claude Code: `/band init <owner>/<repo>`, `/band validate`, `/band doctor`, `/band refresh`, `/band on <profile>`, `/pane`.

In a terminal (`node bin/band.mjs ...`, or `band ...` if you install the package): `init`, `validate`, `doctor`, `refresh`, `show`, `migrate`, `schedule install|status|uninstall`, `version`.

## Privacy and safety

- Read-only: the band only reads pull requests and issues. It never writes to GitHub.
- It uses your own `gh` sign-in. Use a fine-grained read-only token. No secret goes in the config file.
- It sends nothing to the authors or to any model. Service checks are off unless you list a URL, and only local addresses are accepted unless you allow more.

Details are in `docs/PRIVACY.md`.

## Troubleshooting

Run `band doctor` first. The most common fixes:

| You see | Do this |
| --- | --- |
| `No config yet` | `/band init <owner>/<repo>` |
| `unavailable: ... "gh" is not installed` | Install from https://cli.github.com |
| `unavailable: gh is not signed in` | `gh auth login` in a terminal |
| No lanes | Check the label is on an open pull request: `gh pr list --repo <owner>/<repo> --label band` |
| `run "band migrate"` | An older config file. `band migrate` updates it and keeps a backup. |

More in `docs/TROUBLESHOOTING.md`.

## Roadmap

- Sort lane cards by urgency and show a "stuck for 3h" tag.
- A throughput sparkline (merged pull requests per day).
- A compact mode for narrow panes, and colours that follow light and dark themes.
- A "next action" line worked out by rules, such as "Merge #123: approved and green".

## Contributing

Run the tests with `claude plugin test .` and `node --test "test-node/*.test.mjs"`. Tests use output recorded from the real `gh` tool (`test/fixtures/`). After you change a fixture run `node scripts/gen-fixtures.mjs`. After you change `src/types.ts` run `node scripts/gen-contract.mjs`. Keep the project free of names, paths and addresses that belong to one person: `node scripts/check-neutral.mjs` checks this.

## Licence

MIT. See `LICENSE`. See `CHANGELOG.md` for what changed.
