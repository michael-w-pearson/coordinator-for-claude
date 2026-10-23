// A complete data source in 20 lines. Any language works: print JSON, exit 0.
// Use it with:  { "type": "command", "argv": ["node", "examples/command-source.mjs"] }
//
// Replace the list below with a call to your tracker (GitLab, Linear, Jira, a CI system).
// Keep it read-only. Print a plain reason on standard error and exit 1 when it cannot work.

const tickets = [
  { id: 'TRK-1', title: 'Fix the login page', column: 'In progress', blockedBy: '' },
  { id: 'TRK-2', title: 'Update the pricing table', column: 'In review', blockedBy: 'TRK-1' },
  { id: 'TRK-3', title: 'Ship the new onboarding', column: 'Done', blockedBy: '' },
]

const stageOf = { 'In progress': 'build', 'In review': 'review', Done: 'merged' }

const lanes = tickets.map(t => ({
  title: t.title,
  ref: t.id,
  url: `https://tracker.example.com/${t.id}`,
  state: t.column.toLowerCase(),
  stage: stageOf[t.column] ?? 'build',
  status: t.column === 'Done' ? 'done' : t.blockedBy ? 'waiting' : 'moving',
  ...(t.blockedBy ? { blockedBy: t.blockedBy } : {}),
}))

console.log(JSON.stringify({ feedVersion: 1, lanes, needs: [] }))
