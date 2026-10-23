// Entry point of the `band` command: picks the sub-command.

import { doctor, graph, init, refresh, show, validate, version } from './commands.ts'
import { GRAPH_HELP, INIT_HELP, DOCTOR_HELP, REFRESH_HELP, SHOW_HELP, VALIDATE_HELP } from './commands.ts'
import { migrate, MIGRATE_HELP } from './migrate-cmd.ts'
import { scheduleCommand, SCHEDULE_HELP } from './schedule-cmd.ts'

const USAGE = `band - a status band for Claude Code, built from your GitHub pull requests.

Usage: band <command> [options]

  init       Write a starter config for your repositories
  validate   Check config.json and say what is wrong
  doctor     Check Node, gh, the config, the data and the scheduled job
  refresh    Fetch fresh data now
  show       Print the band as text
  graph      Print lanes and their dependencies as a Mermaid diagram
  migrate    Upgrade an old config or profiles file
  schedule   Refresh on a timer (install, uninstall, status)
  version    Print the version

Run "band <command> --help" for the options of one command.`

const HELP: Record<string, string> = {
  init: INIT_HELP, validate: VALIDATE_HELP, doctor: DOCTOR_HELP, refresh: REFRESH_HELP,
  show: SHOW_HELP, graph: GRAPH_HELP, migrate: MIGRATE_HELP, schedule: SCHEDULE_HELP,
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    const topic = command === 'help' ? rest[0] : undefined
    console.log(topic && HELP[topic] ? HELP[topic] : USAGE)
    return command ? 0 : 2
  }
  try {
    switch (command) {
      case 'graph': return await graph(rest)
      case 'init': return await init(rest)
      case 'validate': return await validate(rest)
      case 'doctor': return await doctor(rest)
      case 'refresh': return await refresh(rest)
      case 'show': return await show(rest)
      case 'migrate': return await migrate(rest)
      case 'schedule': return await scheduleCommand(rest)
      case 'version': case '--version': case '-v': return await version()
      default:
        console.error(`Unknown command "${command}". Run "band --help" to see the commands.`)
        return 2
    }
  } catch (e) {
    console.error(`band ${command} failed: ${e instanceof Error ? e.message : String(e)}. Run "band doctor" to check your setup.`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
