// Builds the operating-system job that runs `band refresh` on a timer. Pure: it returns files and commands,
// and the CLI writes and runs them.

export const TASK_NAME = 'coordinator-band-refresh'
const MAC_LABEL = 'band.coordinator.refresh'
const CRON_TAG = '# coordinator-band-refresh'

export type ScheduleOptions = {
  nodePath: string
  scriptPath: string
  home: string
  intervalMinutes: number
  userHome: string
  uid?: number
  hasSystemd?: boolean
}
export type Schedule = {
  name: string
  files: { path: string; content: string }[]
  install: string[][]
  uninstall: string[][]
  status: string[]
  summary: string
}

const winPath = (p: string): string => p.replace(/\//g, '\\')
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
// systemd: double-quote, escape \ and ", and double the % that systemd would expand.
const unit = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

export function clampInterval(n: number): number {
  return Math.min(59, Math.max(1, Math.floor(n) || 5))
}

function windows(o: ScheduleOptions, n: number): Schedule {
  const home = winPath(o.home)
  const vbs = `${home}\\launch-refresh.vbs`
  const q = (s: string): string => s.replace(/"/g, '""')
  const content = [
    "' Starts the refresh with no console window. Written by: band schedule install",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Environment("Process")("COORDINATOR_BAND_HOME") = "${q(home)}"`,
    `shell.Run """${q(winPath(o.nodePath))}"" ""${q(winPath(o.scriptPath))}"" refresh --quiet", 0, True`,
    '',
  ].join('\r\n')
  return {
    name: TASK_NAME,
    files: [{ path: vbs, content }],
    install: [
      ['schtasks', '/Create', '/SC', 'MINUTE', '/MO', String(n), '/TN', TASK_NAME, '/TR', `wscript.exe //B //Nologo "${vbs}"`, '/F'],
      // Run a missed start as soon as the machine is awake again, and also on battery. A sleeping laptop must not leave the band hours old.
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Set-ScheduledTask -TaskName '${TASK_NAME}' -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1))`],
    ],
    uninstall: [['schtasks', '/Delete', '/TN', TASK_NAME, '/F']],
    status: ['schtasks', '/Query', '/TN', TASK_NAME],
    summary: `Windows Task Scheduler task "${TASK_NAME}" runs "band refresh" every ${n} minute(s) with no window. Remove it with: band schedule uninstall`,
  }
}

function macos(o: ScheduleOptions, n: number): Schedule {
  const plist = `${o.userHome}/Library/LaunchAgents/${MAC_LABEL}.plist`
  const log = `${o.home}/logs/launchd.log`
  const uid = o.uid ?? 501
  const arg = (s: string): string => `    <string>${xml(s)}</string>`
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${MAC_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    arg(o.nodePath), arg(o.scriptPath), arg('refresh'), arg('--quiet'),
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${n * 60}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>COORDINATOR_BAND_HOME</key>',
    `    <string>${xml(o.home)}</string>`,
    '    <key>PATH</key>',
    '    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
  const service = `gui/${uid}/${MAC_LABEL}`
  return {
    name: TASK_NAME,
    files: [{ path: plist, content }],
    // The first bootout clears an older copy; the CLI ignores its failure.
    install: [['launchctl', 'bootout', `gui/${uid}`, plist], ['launchctl', 'bootstrap', `gui/${uid}`, plist], ['launchctl', 'kickstart', '-k', service]],
    uninstall: [['launchctl', 'bootout', `gui/${uid}`, plist]],
    status: ['launchctl', 'print', service],
    summary: `macOS LaunchAgent "${MAC_LABEL}" runs "band refresh" every ${n} minute(s). Remove it with: band schedule uninstall`,
  }
}

function linux(o: ScheduleOptions, n: number): Schedule {
  const env = [`COORDINATOR_BAND_HOME=${o.home}`, `PATH=/usr/local/bin:/usr/bin:/bin:${o.userHome}/.local/bin`]
  const exec = [o.nodePath, o.scriptPath, 'refresh', '--quiet']
  if (o.hasSystemd) {
    const dir = `${o.userHome}/.config/systemd/user`
    const timer = `${TASK_NAME}.timer`
    const service = [
      '[Unit]', 'Description=coordinator-band refresh', '',
      '[Service]', 'Type=oneshot',
      ...env.map(e => `Environment=${unit(e)}`),
      `ExecStart=${exec.map(unit).join(' ')}`, '',
    ].join('\n')
    const timerText = [
      '[Unit]', 'Description=Run the coordinator-band refresh on a timer', '',
      '[Timer]', 'OnBootSec=1min', `OnUnitActiveSec=${n}min`, '',
      '[Install]', 'WantedBy=timers.target', '',
    ].join('\n')
    return {
      name: TASK_NAME,
      files: [{ path: `${dir}/${TASK_NAME}.service`, content: service }, { path: `${dir}/${timer}`, content: timerText }],
      install: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', timer]],
      uninstall: [['systemctl', '--user', 'disable', '--now', timer], ['systemctl', '--user', 'daemon-reload']],
      status: ['systemctl', '--user', 'is-active', timer],
      summary: `systemd user timer "${timer}" runs "band refresh" every ${n} minute(s). Remove it with: band schedule uninstall`,
    }
  }
  // cron turns a bare % into a newline, so escape it.
  const line = `*/${n} * * * * env ${[...env, ...exec].map(sh).join(' ')} ${CRON_TAG}`.replace(/%/g, '\\%')
  const drop = `crontab -l 2>/dev/null | grep -v ${sh(CRON_TAG)}`
  return {
    name: TASK_NAME,
    files: [],
    install: [['sh', '-c', `( ${drop}; printf '%s\\n' ${sh(line)} ) | crontab -`]],
    uninstall: [['sh', '-c', `${drop} | crontab -`]],
    status: ['sh', '-c', `crontab -l 2>/dev/null | grep -q ${sh(CRON_TAG)}`],
    summary: `A crontab line tagged "${CRON_TAG}" runs "band refresh" every ${n} minute(s). Remove it with: band schedule uninstall`,
  }
}

export function buildSchedule(platform: 'win32' | 'darwin' | 'linux', o: ScheduleOptions): Schedule {
  const n = clampInterval(o.intervalMinutes)
  return platform === 'win32' ? windows(o, n) : platform === 'darwin' ? macos(o, n) : linux(o, n)
}
