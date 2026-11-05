// A multi-byte character split across two stdout chunks must survive in both runners.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const codexcode = require('../../src/agent/codexcode')
const claudecode = require('../../src/agent/claudecode')

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function fakeChild() {
  const c = new EventEmitter()
  c.pid = 1
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.stdin = { destroyed: false, on() {}, write() {}, end() {} }
  c.kill = () => { setTimeout(() => c.emit('close', 143), 1) }
  return c
}

const splitInsideChar = (obj) => {
  const line = Buffer.from(JSON.stringify(obj) + '\n')
  const i = line.indexOf(Buffer.from('中')) + 1
  return [line.subarray(0, i), line.subarray(i)]
}

test('codex exec keeps Chinese text split across chunks', async () => {
  const c = fakeChild()
  const texts = []
  const p = codexcode.runTurn({ prompt: 'hi', provider: {}, bin: 'codex', spawnFn: () => c, closeGraceMs: 10, onEvent: (e) => { if (e.text) texts.push(e.text) } })
  await tick()
  for (const part of splitInsideChar({ type: 'item.completed', item: { type: 'agent_message', text: '中文消息' } })) c.stdout.emit('data', part)
  c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n'))
  await tick()
  c.emit('close', 0)
  await p
  assert.ok(texts.includes('中文消息'), JSON.stringify(texts))
})

test('claude keeps Chinese text split across chunks', async () => {
  const c = fakeChild()
  const texts = []
  const p = claudecode.runTurn({ prompt: 'hi', provider: {}, bin: 'claude', spawnFn: () => c, closeGraceMs: 10, onEvent: (e) => { if (e.text) texts.push(e.text) } })
  await tick()
  for (const part of splitInsideChar({ type: 'assistant', message: { content: [{ type: 'text', text: '中文消息' }] } })) c.stdout.emit('data', part)
  c.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '中文消息', session_id: 's' }) + '\n'))
  await tick()
  c.emit('close', 0)
  await p
  assert.ok(texts.includes('中文消息'), JSON.stringify(texts))
})
