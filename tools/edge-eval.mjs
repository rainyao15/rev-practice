// Evaluate an expression in a Chromium page target, with a hard timeout.
//   node tools/edge-eval.mjs <port> "<expression>"
const [, , port, expr] = process.argv
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

const timer = setTimeout(() => {
  console.error('timeout waiting for the page')
  process.exit(2)
}, 15000)

const r = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
})
clearTimeout(timer)

if (r.error) {
  console.error(JSON.stringify(r.error))
  process.exit(1)
}
const v = r.result?.result
if (v && 'value' in v) {
  console.log(typeof v.value === 'string' ? v.value : JSON.stringify(v.value))
} else {
  console.log(JSON.stringify(r.result))
}
ws.close()
process.exit(0)
