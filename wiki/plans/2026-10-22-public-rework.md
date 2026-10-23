---
status: accepted
owner: maintainers
related: the earlier private version of this mod
---

# Public rework of the coordinator band

## Status
Accepted 2026-10-22. Reviewed with the model-portability and silent-failure lenses (see Review).

## Context
The band is a Claude Code mod. It shows lanes, NEEDS YOU, SERVICES, MERGE LINE and CODEX CLOUD.
It works for one person. Paths, owner, repo names, ports, session ids and a a second language runtime refresher are hard-coded.
Failures print `?` or nothing. Lanes can be hand-written.

## Outcome
A stranger installs the mod, runs one command, and sees a band built from their own GitHub PRs.
Nothing in the repo names one person or machine. The band never calls an LLM.

## Design
- One pure core in `src/`. It takes a `Host` (run, read, write, now). Two hosts: the mod (`$.process`, `$.fs`) and Node (CLI).
- One config file `config.json` (versioned). One data file per profile `data/<profile>.json` (versioned).
- Sources are plugins: `Source { type, requires, fetch, toLane, fetchNeeds? }`. Built in: `github`, `file` (the override file), `command` (any program that prints JSON). A contributor adds a file under `src/sources/` and one registry line.
- Lane stage/status come from declarative rules (data, not code). Stages, descriptions, colours are config.
- Every section carries a state: `ok | stale | empty | error`, plus `fetchedAt` and `reason`. One function turns it into a badge. No bare `?`.
- A pure view-model (`buildView`) feeds both the pane (JSX) and a plain-text renderer (`band show`). Tests cover the view-model.
- Refresh runs in the mod on a timer (no scheduler). `band schedule install` adds an OS job (schtasks / launchd / systemd or cron) that runs `band refresh`. Both write the same data file. A fresh file is a lease: the second writer skips.
- Windows: every child uses `windowsHide`; the scheduled job starts through a hidden `wscript` launcher.

## Acceptance (artifact level)
1. `band init` writes a valid starter config and example override; `band validate` accepts it and rejects a broken one with a line-level message. Test + recorded run.
2. `git grep` for the maintainer's names, paths, ports, session ids, a second runtime call finds nothing in code, config defaults or docs. Test scans the repo.
3. `band schedule install|status|uninstall` builds the right command for win32, darwin, linux. Unit tests on the generated task text. Windows install proven on this machine under a throwaway task name. Mod timer refresh covered by a test with a mock clock.
4. No a second language runtime anywhere. Missing `gh` or Node gives a message that names the tool and the install URL. Test.
5. A second source type loads through the same interface with no core change (test uses `file` and `command`).
6. With a label configured, a recorded `gh pr list` fixture becomes lanes with stage/status/blockedBy from the rules. No LLM or network call in the derive path (test injects a Host that throws on anything but `gh`).
7. Changing `stages` in config changes strip, legend and description (test).
8. Each section state renders the same way; an unavailable fetch says `unavailable: <reason>`; a no-head merge line says `Head #none`. Test asserts the rendered text contains no bare `?`.
9. Parser and render tests run on fixtures recorded from real `gh`. Old config/data files get a message naming the file, its version, the expected version and the fix. Test.
10. README (screenshot as text capture, troubleshooting), LICENSE (MIT), CHANGELOG, PRIVACY section. Health URLs off unless listed; non-local URLs warn. Test for the warning.

Runtime proof (not by the builder): `band refresh` on the maintainer's real data, looked at once.

## Sequence (one writer per file)
1. Core types, config, validation, states (me).
2. Sources + rules + merge-line + codex parsers (me), fixtures recorded.
3. View-model + text renderer + mod JSX (me).
4. CLI + init + migrate + schedule (subagent, disjoint files `src/cli/*`, `src/schedule.ts`), reviewed by me.
5. Docs (subagent, `README.md`, `docs/*`, `CHANGELOG.md`) after the config schema is fixed.
6. Tests, validate, type-check, capture, commit. Batch the checks, then commit.

## Review
Model portability: the core does not assume Claude. The `command` source and JSON files are the contract, so any tool or model can feed it. No prompt text is shipped. The mod is the only Claude-specific file.
Silent failure: every fetch returns a result or a reason. Timeouts are set on every child. Atomic writes. A missing tool becomes a section error, not an empty section. A config that fails validation blocks refresh and shows the reason in the pane. A stale file is shown as stale with its age.

## Consequences
Stage rules are a small vocabulary; unusual flows need the `command` source.
`insecure` TLS health checks are dropped; the mod uses the host fetch.
