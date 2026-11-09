// Loaded by Claude Code inside each session (as MCP server "tg").
// Bridge -> here -> Claude:  messages and permission verdicts.
// Claude -> here -> bridge:  replies and permission requests.
import http from 'node:http'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { BRIDGE_PORT, getSecret, post } from './state.js'

const name = process.env.CREW_AGENT || path.basename(process.cwd())
const folder = process.env.CREW_FOLDER || process.cwd()
const toBridge = (route, body) => post(BRIDGE_PORT, route, { name, ...body })

const mcp = new Server(
  { name: 'tg', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions:
      `You are agent "${name}". Messages from the user's phone (Telegram) arrive as ` +
      '<channel source="tg" chat_id="..." from="...">. The user may not be at the computer: ' +
      'answer every such message with the reply tool, passing its chat_id. ' +
      'Keep replies short and easy to read on a phone.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: "Send a message to the user's phone (Telegram)",
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'chat_id from the <channel> tag' },
          text: { type: 'string', description: 'The message' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)
  const { chat_id, text } = req.params.arguments
  try {
    const r = await toBridge('/reply', { chat_id, text })
    return { content: [{ type: 'text', text: r.ok ? 'sent' : `not sent: ${r.error}` }] }
  } catch {
    return { content: [{ type: 'text', text: 'not sent: the Telegram bridge is not running' }] }
  }
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => toBridge('/permission', params).catch(() => {}),
)

await mcp.connect(new StdioServerTransport())

// Small local server the bridge pushes to.
const secret = getSecret()
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.headers['x-secret'] !== secret) return res.writeHead(403).end()
  const data = JSON.parse(body || '{}')
  if (req.url === '/message') {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: data.text, meta: { chat_id: String(data.chat_id), from: data.from || 'telegram' } },
    })
  } else if (req.url === '/verdict') {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: data.request_id, behavior: data.behavior },
    })
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
})

server.listen(0, '127.0.0.1', () => {
  const register = () =>
    toBridge('/register', { folder, port: server.address().port, pid: process.ppid }).catch(() => {})
  register()
  setInterval(register, 15000) // heartbeat; also re-registers after a bridge restart
})

// Tell the bridge when the session ends.
let leaving = false
async function leave() {
  if (leaving) return
  leaving = true
  await toBridge('/unregister', {}).catch(() => {})
  process.exit(0)
}
process.stdin.on('close', leave)
process.on('SIGINT', leave)
process.on('SIGTERM', leave)
