import { expect, test } from 'claude-code/testing'

import { buildSchedule } from '../src/schedule.ts'

const base = { nodePath: '/opt/my node/bin/node', scriptPath: '/opt/band/bin/band.mjs', home: '/home/u/.coordinator-band', intervalMinutes: 5, userHome: '/home/u' }

test('windows: a hidden vbs launcher and exact schtasks arguments', () => {
  const s = buildSchedule('win32', { ...base, nodePath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\Users\\Some One\\band\\bin\\band.mjs', home: 'C:\\Users\\Some One\\.coordinator-band' })
  const vbs = 'C:\\Users\\Some One\\.coordinator-band\\launch-refresh.vbs'
  expect(s.install[0]).toEqual(['schtasks', '/Create', '/SC', 'MINUTE', '/MO', '5', '/TN', 'coordinator-band-refresh', '/TR', `wscript.exe //B //Nologo "${vbs}"`, '/F'])
  expect(s.install[1]?.join(' ')).toContain('-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries')
  expect(s.uninstall[0]).toEqual(['schtasks', '/Delete', '/TN', 'coordinator-band-refresh', '/F'])
  expect(s.status).toEqual(['schtasks', '/Query', '/TN', 'coordinator-band-refresh'])
  expect(s.files[0]?.path).toBe(vbs)
  const content = s.files[0]?.content ?? ''
  expect(content).toContain('shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\Some One\\band\\bin\\band.mjs"" refresh --quiet", 0, True')
})

test('interval is clamped to 1..59', () => {
  expect(buildSchedule('win32', { ...base, intervalMinutes: 0 }).install[0]).toContain('5')
  expect(buildSchedule('win32', { ...base, intervalMinutes: 500 }).install[0]).toContain('59')
  expect(buildSchedule('win32', { ...base, intervalMinutes: 1 }).install[0]).toContain('1')
})

test('macos: a launch agent with the interval, run at load, logs and an escaped path', () => {
  const s = buildSchedule('darwin', { ...base, userHome: '/Users/u', home: '/Users/u/Band & Co', uid: 502 })
  const plist = s.files[0]
  expect(plist?.path).toBe('/Users/u/Library/LaunchAgents/band.coordinator.refresh.plist')
  expect(plist?.content).toContain('<key>StartInterval</key>\n  <integer>300</integer>')
  expect(plist?.content).toContain('<key>RunAtLoad</key>\n  <true/>')
  expect(plist?.content).toContain('<string>/opt/my node/bin/node</string>')
  expect(plist?.content).toContain('/Users/u/Band &amp; Co/logs/launchd.log')
  expect(s.install.map(c => c.slice(0, 2))).toEqual([['launchctl', 'bootout'], ['launchctl', 'bootstrap'], ['launchctl', 'kickstart']])
  expect(s.install[1]).toEqual(['launchctl', 'bootstrap', 'gui/502', plist?.path])
  expect(s.uninstall[0]).toEqual(['launchctl', 'bootout', 'gui/502', plist?.path])
})

test('linux with systemd: a service and a timer under the user config folder', () => {
  const s = buildSchedule('linux', { ...base, hasSystemd: true, intervalMinutes: 10 })
  const [service, timer] = s.files
  expect(service?.path).toBe('/home/u/.config/systemd/user/coordinator-band-refresh.service')
  expect(timer?.path).toBe('/home/u/.config/systemd/user/coordinator-band-refresh.timer')
  expect(timer?.content).toContain('OnUnitActiveSec=10min')
  expect(timer?.content).toContain('WantedBy=timers.target')
  expect(service?.content).toContain('ExecStart="/opt/my node/bin/node" "/opt/band/bin/band.mjs" "refresh" "--quiet"')
  expect(s.install).toEqual([['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'coordinator-band-refresh.timer']])
})

test('linux without systemd: a tagged crontab line that is replaced, not duplicated', () => {
  const s = buildSchedule('linux', { ...base, hasSystemd: false })
  expect(s.files).toEqual([])
  const install = s.install[0]?.[2] ?? ''
  expect(install).toContain('grep -v')
  expect(install).toContain('# coordinator-band-refresh')
  expect(install).toContain('*/5 * * * *')
  expect(install).toContain("'/opt/my node/bin/node'")
  expect(s.uninstall[0]?.[2]).toContain('grep -v')
  expect(s.status[2]).toContain('grep -q')
})
