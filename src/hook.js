// Claude Code "Stop" hook: tells the bridge an agent finished its turn.
// Must never block or fail the session, so errors are ignored.
import { BRIDGE_PORT, post } from './state.js'

let input = ''
for await (const chunk of process.stdin) input += chunk

try {
  const { last_assistant_message, session_id } = JSON.parse(input || '{}')
  await post(BRIDGE_PORT, '/hook', { name: process.env.CREW_AGENT, last_assistant_message, session_id }, 3000)
} catch {}
process.exit(0)
