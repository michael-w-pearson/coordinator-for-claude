# Privacy and safety

## What leaves your machine

Nothing leaves your machine because of this project.

- The coordinator runs the GitHub tool `gh` on your machine. `gh` talks to GitHub with your own sign-in. That is the same traffic as running `gh pr list` yourself.
- The coordinator sends nothing to its authors, to analytics, to a language model, or to any other server.
- The coordinator never calls a language model. It costs no tokens. Everything is computed from GitHub fields and your rules.
- The coordinator stores files only in its home folder (`~/.claude-coordinator` or `COORDINATOR_HOME`) and one small key-value entry in Claude Code's own plugin store (which session uses which profile).

## Read-only by default

- The GitHub source runs only `gh pr list`, `gh pr view`, `gh issue view` and `gh search`. It never creates, edits, comments, labels or merges anything.
- The `command` and `mergeLine` settings run programs you name. Those programs are yours. The coordinator does not check what they do, so name only programs you trust.
- A need can have reply buttons. A button sends its text to another Claude Code session only when you press it.

## Tokens and secrets

- Do not put a token, password or key in `config.json`. The file has no place for one, and the coordinator never reads environment variables other than the home folder settings.
- The coordinator uses the sign-in of `gh`. Create it with `gh auth login`.
- Give that sign-in the least access that works. For public repositories you need no scope. For private repositories use a fine-grained token with read-only access to the repositories you list: **Metadata: read**, **Pull requests: read**, **Issues: read**, and **Commit statuses: read** (so check results show up).
- If you use a classic token, the `repo` scope is the smallest that sees private repositories. It also allows writes, so prefer the fine-grained token. The coordinator itself never writes.

## Service checks are opt-in

- The coordinator contacts no service URL unless you list it under `services`.
- By default only addresses on your own machine or private network are accepted. To check another address you must add `"allowRemote": true` to that entry.
- A check is one GET request. The coordinator does not send cookies, headers or a body.

## Files the coordinator writes

| File | Holds |
| --- | --- |
| `config.json` | Your settings. You write it. |
| `data/<name>.json` | Pull request titles, links and states that GitHub returned. Treat it like the pull request page: it can show private titles. |
| `logs/refresh.log` | Times and section states. No titles. |

If you share your home folder, remove `data/` first.

## Reporting a problem

Open an issue in the repository. For a security problem, use the repository's private security advisory form.
