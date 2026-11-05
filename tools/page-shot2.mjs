// Screenshot a page from a Chromium DevTools endpoint.
//   node tools/page-shot2.mjs <port> <out.png> [x,y,w,h]
const [, , port, out, clip] = process.argv
const ENDPOINT = `http://127.0.0.1:${port}`

const targets = await (await fetch(`${ENDPOINT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('no page target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 1
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = id++
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })

await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true })
  ws.addEventListener('error', j, { once: true })
})

const params = { format: 'png' }
if (clip) {
  const [x, y, width, height] = clip.split(',').map(Number)
  params.clip = { x, y, width, height, scale: 1 }
}

const r = await send('Page.captureScreenshot', params)
if (!r.result?.data) {
  console.error(JSON.stringify(r.error || r))
  process.exit(1)
}
const fs = await import('node:fs/promises')
await fs.writeFile(out, Buffer.from(r.result.data, 'base64'))
console.log('saved', out)
ws.close()
