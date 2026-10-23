# Troubleshooting

First run `band doctor` in a terminal, or `/band doctor` inside Claude Code. It checks the tools, the sign-in and the config, and prints a fix for each failure.

## The pane says "not set up for this session"

- **"No config yet."** Run `/band init <owner>/<repo>` in Claude Code, or `band init` in a terminal.
- **"This session has no profile."** Your config has several profiles and none matches this session. Run `/band on <name>`, or add a `match` block to the profile (see `docs/CONFIG.md`).
- **A red line with a file name.** The config has a mistake. The line says which key and what to do. Fix it, save, and wait up to 30 seconds. The pane re-reads the file on its own.

## A section says "unavailable: ..."

The text after the colon is the reason. The most common ones:

| Reason | Fix |
| --- | --- |
| `the GitHub command-line tool "gh" is not installed` | Install it from https://cli.github.com. Restart Claude Code. |
| `gh is not signed in` | In a terminal run `gh auth login`. |
| `a repository was not found or you cannot see it` | Check `owner` and `repos` in the config. For a private repo, sign in with an account that can see it. |
| `gh failed: HTTP 502` or a timeout | GitHub or your network had a problem. The band keeps the last good lanes and tries again on the next refresh. |
| `merge line command gave no result` | Run the command from the config in a terminal in the same folder. It must print a `Head: #N` line and `PR #N: note` lines. |
| `codex printed text this release cannot read` | The `codex cloud list` output changed. Open an issue and paste a redacted copy. |
| `"<program>" could not run` | The program in a `command` source or `mergeLine` is not installed or the path is wrong. |

A section never goes blank by itself. If a fetch fails, the last good data stays and the header says how old it is.

## A section says "stale: data 2h old"

The data is older than `refresh.staleAfterMinutes` (30 by default). A refresh may be failing without being fixed. It is amber until the data is 4 hours old, then red. Hand-written lanes count too: update the `updated` time in your override file when you edit it. Look for the reason in a nearby `unavailable` header, or run `/band refresh`.

## No lanes appear

- With `label`, the pull request must be open and carry that exact label.
- With `author: "@me"`, only your own open pull requests show.
- Run `gh pr list --repo <owner>/<repo> --label <label>` in a terminal. If that prints nothing, the band has nothing to show.

## The scheduled job

- **Windows:** Task Scheduler shows `coordinator-band-refresh`. It starts a hidden launcher, so no window appears. Run `band schedule status`.
- **macOS:** the job is a LaunchAgent. Run `launchctl list | grep coordinator-band`.
- **Linux:** a systemd user timer (`systemctl --user list-timers`), or a line in `crontab -l` tagged `coordinator-band`.
- A scheduled job cannot read files that only a running Claude Code session can see. The band keeps all its files in `~/.coordinator-band` for this reason.
- The job runs a missed start as soon as the computer wakes, and also on battery.
- You do not need the job. With `refresh.mode` set to `auto` (the default), the pane fetches for itself while Claude Code is open.

## "needs a newer version" or "run band migrate"

A file has a version number. If the message names `config.json`, run `band migrate`. It keeps a backup next to the file. If it names a `data/` file, run `band refresh`, which writes it again.

## Windows

- The band hides every child window. If you see a console flash, run `band doctor` and open an issue.
- `codex` is found as `codex.cmd` automatically.
- Use forward slashes or doubled backslashes in JSON paths.

## Still stuck

Open an issue with the output of `band doctor` and the `logs/refresh.log` tail. Remove private titles first.
