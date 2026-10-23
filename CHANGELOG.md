# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/). Config and data files carry their own version numbers (`configVersion`, `dataVersion`). A change to either is marked **schema**.

## [Unreleased]

### Added
- Default stage colours are one OKLCH ramp (violet to green); stage colours accept hex. A **plan** stage before build. A pull request counts as a plan when all its changed files are under `planPaths` or its title matches `planTitle`. Rules can test `plan`. The file list is part of the existing `gh pr list` call, so there is no extra request.

## [1.0.0] - 2026-10-22

First public release. The project began as a private mod and was reworked so it holds nothing specific to one person or machine.

### Added
- `band init`, `band validate`, `band doctor`, `band refresh`, `band show`, `band migrate`, `band schedule`. And the matching `/band` commands inside Claude Code.
- One config file with defaults (`config.json`). **schema** `configVersion: 1`.
- Data sources as plugins: `github` (reference), `file`, and `command` (any program that prints JSON).
- Lanes derived from GitHub: every open pull request with a label becomes a lane. Stage and status come from rules in config.
- Configurable stages, descriptions, colours and status colours.
- Four section states, shown the same way everywhere: ok, stale, empty, error. Every section shows its age. A failed fetch says `unavailable: <reason>` and keeps the last good data.
- Refresh inside Claude Code (no scheduler needed), or with an operating-system job on Windows, macOS and Linux.
- Tests that use recorded `gh` output. **schema** `dataVersion: 1`.
- MIT licence, privacy notes, troubleshooting.

### Changed
- The refresher is TypeScript and runs inside the mod, so no second language is needed.
- Health checks use an HTTP request instead of `curl`. A self-signed certificate shows as down.
- Health URLs must be on your machine or private network unless `allowRemote` is set. They are off unless you list them.

### Fixed
- A failed or empty merge-line run no longer replaces the last good result. The section shows `unavailable: <reason>`.
- The merge-line section printed `?` when it had no head. It now prints `Head #none`. No section prints a bare `?`.
- Hidden child processes on Windows: no console window flashes (`windowsHide`, and a hidden launcher for the scheduled job).

- A section's age is the age of its data, never the time the pane last looked. Hand-written lanes carry an `updated` time, so a stale file shows `stale: data 8h old` (amber, red after 4 hours).
- A hand-written lane that names a merged pull request becomes a done lane. A closed one is dropped.
- The scheduled job on Windows runs a missed start after sleep and runs on battery.
- The pane redraws every 30 seconds so a shown age cannot freeze.

### Removed
- The hand-written `running` list. It was stored but never shown.
- The `insecure` option on services.
