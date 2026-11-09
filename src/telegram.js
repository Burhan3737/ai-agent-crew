// Minimal Telegram Bot API client using fetch.

const API = process.env.TG_API || 'https://api.telegram.org/bot' // TG_API: tests only

export async function tg(token, method, params = {}) {
  const res = await fetch(`${API}${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60000),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`${method}: ${data.description}`)
  return data.result
}

export const chunkOrDoc = (text) => (text.length <= 4000 ? 'message' : 'document')

// Plain-text message; long text is sent as a .md file instead.
export async function sendText(token, chatId, text, extra = {}) {
  text = text || '(empty)'
  if (chunkOrDoc(text) === 'message') {
    return tg(token, 'sendMessage', { chat_id: chatId, text, ...extra })
  }
  const form = new FormData()
  form.append('chat_id', String(chatId))
  form.append('caption', text.slice(0, 200).toWellFormed() + '…')
  form.append('document', new Blob([text], { type: 'text/markdown' }), 'reply.md')
  if (extra.reply_markup) form.append('reply_markup', JSON.stringify(extra.reply_markup))
  const res = await fetch(`${API}${token}/sendDocument`, { method: 'POST', body: form })
  const data = await res.json()
  if (!data.ok) throw new Error(`sendDocument: ${data.description}`)
  return data.result
}

// Long-polls one bot forever, calling onUpdate for each update.
export async function poll(token, onUpdate) {
  let offset = 0
  for (;;) {
    try {
      const updates = await tg(token, 'getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      })
      for (const u of updates) {
        offset = u.update_id + 1
        try {
          await onUpdate(u)
        } catch (err) {
          console.error('update failed:', err.message)
        }
      }
    } catch (err) {
      console.error('poll error:', err.message)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

export const button = (text, data) => ({ text, callback_data: data })
export const urlButton = (text, url) => ({ text, url })
export const keyboard = (rows) => ({ reply_markup: { inline_keyboard: rows } })
