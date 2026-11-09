// "Start at sign-in": one small file in the Windows Startup folder that runs the bridge hidden.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './state.js'

const startupFile = () =>
  path.join(
    process.env.CREW_STARTUP || path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), // CREW_STARTUP: tests only
    'crew-bridge.vbs',
  )

// The 0 runs it with no window; False means Windows doesn't wait for it.
export const autostartScript = (node, bridge) => `CreateObject("WScript.Shell").Run """${node}"" ""${bridge}""", 0, False\r\n`

export const isAutostartOn = () => fs.existsSync(startupFile())

export function enableAutostart() {
  fs.writeFileSync(startupFile(), autostartScript(process.execPath, path.join(ROOT, 'src', 'bridge.js')))
}

export function disableAutostart() {
  fs.rmSync(startupFile(), { force: true })
}
