# Adding a data source

A source is where lanes come from. GitHub is the built-in reference. You can add GitLab, Linear, Jira, a CI system or your own tracker in one of two ways.

## Way 1: a program that prints JSON (no code changes)

Write any program, in any language. It prints this on standard output and exits with code 0:

```json
{
  "feedVersion": 1,
  "updated": "2026-10-22T10:00:00Z",
  "lanes": [
    {
      "title": "Ship the invoice export",
      "ref": "TRK-42",
      "url": "https://tracker.example.com/TRK-42",
      "state": "in review",
      "stage": "review",
      "status": "blocked",
      "blockedBy": "waiting on legal"
    }
  ],
  "needs": [
    { "text": "Approve the vendor contract", "url": "https://tracker.example.com/TRK-50" }
  ]
}
```

`updated` (optional) is when the program or person last wrote the lanes. The LANES header shows `stale: data Nh old` when it is old. A bare list of lanes also works.

| Lane field | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Shown text. |
| `stage` | yes | One of your stage ids (`build`, `verify`, `review`, `merge-line`, `merged` by default). |
| `status` | no | `moving`, `waiting`, `blocked`, `done`. Default `waiting`. |
| `blockedBy` | no | Why it waits. Text such as `#42` draws a chain to the lane with that number. |
| `ref` | no | A stable id. Lanes from different sources with the same `ref` join. |
| `url`, `state`, `updatedAt`, `failed`, `codex` | no | Link, short text, ISO time, failed mark, Codex task id. |

Add it to `config.json`:

```json
{ "type": "command", "argv": ["node", "/path/to/my-source.mjs"], "timeoutSeconds": 30 }
```

If the program fails, the LANES header shows `unavailable: "node" failed: <first line of its error>` and the last good lanes stay on screen.
`examples/command-source.mjs` is a complete small example.

## Way 2: a source in this project

A source is one object with this shape (see `src/types.ts`):

```ts
type Source = {
  type: string                                   // the "type" you write in config.json
  requires(config): { command: string; install: string }[]   // tools it needs, and where to get them
  fetch(config, ctx): Promise<Raw[]>             // get raw items; throw SourceError("plain reason") on failure
  toLane(raw, config, ctx): Lane | null          // map one item: lane, stage, status, blockedBy
  fetchNeeds?(config, ctx): Promise<Need[]>      // optional: things that need the person
}
```

`ctx.host.run(argv)` runs a program. `ctx.host.readFile(path)` reads a file. Use them instead of Node or Claude Code calls, so the source works in the pane, in `coordinator refresh` and in tests.

Steps:

1. Create `src/sources/<name>.ts` that exports your `Source`. Look at `src/sources/github.ts`.
2. Add one line to `src/sources/index.ts`.
3. Add its config type to `src/types.ts` and a check to `src/config.ts`.
4. Record real output from the tool into `test/fixtures/` and write a test like the GitHub tests in `test/core.test.ts`.
5. Run `node scripts/gen-fixtures.mjs` and `claude plugin test .`.

Rules for a source:

- Read only. Never write to the other system.
- Say what is wrong in plain words: not installed, not signed in, not found.
- Never call a language model.
