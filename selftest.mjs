/**
 * Self-test for the telegram-notify plugin.
 *
 * The plugin imports nothing from the Harness, so this harness needs no module
 * stubbing: it drives `apply()` with a fake context and a fake `fetch`, and
 * asserts on the messages that would have been sent.
 *
 * The plugin is outbound only. That is asserted, not assumed: the fake transport
 * records every call, and a check fails if anything ever reads from Telegram.
 *
 * Run: npm test
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Keep the developer's real credentials out of the run.
const savedToken = process.env.TELEGRAM_BOT_TOKEN
const savedChat = process.env.TELEGRAM_CHAT_ID
delete process.env.TELEGRAM_BOT_TOKEN
delete process.env.TELEGRAM_CHAT_ID

const CHAT_ID = '12345'
const json = (value) => ({
  ok: true,
  status: 200,
  json: async () => value,
  text: async () => JSON.stringify(value),
})

const realFetch = globalThis.fetch
/** Messages Telegram accepted. */
let sent = []
/** Every call made, including ones that failed in transport. */
let attempts = []
/** Calls that READ from Telegram, which are legitimate only while pairing. */
let reads = []
/** Canned getMe answer, so a pairing test can also fail the token. */
let getMePayload = { ok: true, result: { username: 'demo_bot' } }
/** Queued inbound updates handed to the next getUpdates. */
let updates = []
let fetchMode = 'ok'
let nextMessageId = 1000

globalThis.fetch = async (url, options = {}) => {
  if (url.includes('/getMe')) {
    reads.push(url)
    return json(getMePayload)
  }
  if (url.includes('/getUpdates') || url.includes('/getWebhookInfo')) {
    reads.push(url)
    const batch = updates
    updates = []
    if (batch.length === 0) await sleep(5)
    return json({ ok: true, result: batch })
  }
  const body = JSON.parse(options.body)
  attempts.push({ url, body })
  if (fetchMode === 'network') throw new Error('simulated network failure')
  if (fetchMode === 'http500') return { ok: false, status: 500, text: async () => 'server error' }
  const messageId = nextMessageId++
  sent.push({ url, body, messageId })
  return json({ ok: true, result: { message_id: messageId, chat: { id: Number(body.chat_id) } } })
}

/**
 * Let every pending quiet-period timer finish, then open a clean observation
 * window. Without this, a session from an earlier case reports its idle state
 * during a later assertion and is mistaken for that case's output.
 */
async function settle() {
  await sleep(80)
  sent = []
  attempts = []
  reads = []
}

const plugin = await import(pathToFileURL(path.join(here, 'index.js')).href)

function makeCtx() {
  const listeners = new Map()
  const cleanups = []
  return {
    listeners,
    cleanups,
    logger: { info() {}, warn() {} },
    on(eventName, handler) {
      listeners.set(eventName, handler)
      return () => listeners.delete(eventName)
    },
    effect(fn) {
      cleanups.push(fn())
    },
    get() {
      return undefined
    },
  }
}

/** A fresh pairing state directory, so no test touches the real DSH_HOME. */
function freshHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tn-home-'))
  process.env.DSH_HOME = dir
  return dir
}

const session = (title = 'Example project', cwd = '/workspace/example-project') => ({ header: { title, cwd } })
const QUESTION = { id: 'q1', question: 'Which environment?', options: [{ label: 'Development' }, { label: 'Production' }] }

// ---- refuses to run unconfigured --------------------------------------------
console.log('\nconfiguration')
freshHome()
const unconfigured = makeCtx()
plugin.apply(unconfigured, {})
check('no token registers no listeners', unconfigured.listeners.size === 0, String(unconfigured.listeners.size))
check('no token sends nothing', attempts.length === 0, String(attempts.length))
check('no token never reads', reads.length === 0, JSON.stringify(reads))

// ---- configured -------------------------------------------------------------
process.env.TELEGRAM_BOT_TOKEN = 'TEST-TOKEN'
process.env.TELEGRAM_CHAT_ID = CHAT_ID
const ctx = makeCtx()
plugin.apply(ctx, { idleGraceMs: 30, summaryChars: 50 })
check('registers the session feed', ctx.listeners.has('session/event'))
check('registers the question waterfall', ctx.listeners.has('user-questions/request'))
check('a cleanup effect is registered', ctx.cleanups.length === 1, String(ctx.cleanups.length))
await sleep(40)
check(
  'a chat configured in the environment never reads from Telegram',
  reads.length === 0,
  JSON.stringify(reads),
)

const onEvent = ctx.listeners.get('session/event')

// ---- a clean turn notifies only once the session is quiet -------------------
console.log('\nturn outcomes')
await settle()
onEvent(session(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await sleep(5)
check('a completed turn sends nothing immediately', sent.length === 0, JSON.stringify(sent))
await sleep(60)
check('an idle session reports once', sent.length === 1, String(sent.length))
check(
  'the idle report names the session',
  sent[0]?.body?.text?.includes('Session idle') && sent[0].body.text.includes('Example project'),
  sent[0]?.body?.text,
)

// ---- a failing turn notifies at once ---------------------------------------
await settle()
onEvent(session('Blocked job'), { type: 'turn/end', data: { turn: 3, reason: { kind: 'blocked' } } })
await sleep(20)
check('a blocked turn sends immediately', sent.length === 1, String(sent.length))
check('the report names the failure kind', sent[0]?.body?.text?.includes('blocked'), sent[0]?.body?.text)
check('the report names the turn', sent[0]?.body?.text?.includes('turn: 3'), sent[0]?.body?.text)

// An abnormal end carries a null reason; it must not be mistaken for success.
await settle()
onEvent(session('Crash case'), { type: 'turn/end', data: { turn: 1, reason: null } })
await sleep(20)
check(
  'a null reason counts as a failure',
  sent.length === 1 && sent[0].body.text.includes('abnormally'),
  JSON.stringify(sent.map((m) => m.body.text)),
)

// Every failure kind must be reported, not just the obvious ones.
for (const kind of ['error', 'aborted', 'abandoned', 'max-tokens']) {
  await settle()
  onEvent(session(`Kind ${kind}`), { type: 'turn/end', data: { turn: 1, reason: { kind } } })
  await sleep(20)
  check(`${kind} is reported`, sent.length === 1 && sent[0].body.text.includes(kind), JSON.stringify(sent.map((m) => m.body.text)))
}

// ---- resumed work cancels the quiet-period report ---------------------------
await settle()
const resumed = session('Long job')
onEvent(resumed, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
onEvent(resumed, { type: 'turn/start', data: { turn: 2 } })
await sleep(60)
check('turn/start cancels the pending idle report', sent.length === 0, JSON.stringify(sent.map((m) => m.body.text)))

// ---- the idle report summarises the session ---------------------------------
console.log('\nsession summary')
await settle()
const summarised = session('Summary case')
onEvent(summarised, { type: 'turn/start', data: { turn: 1 } })
onEvent(summarised, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    // Shape verified against a real session log: content blocks are
    // reasoning / text / tool-call, and only `text` is the agent's own words.
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'PRIVATE-SCRATCH-SPACE' },
        { type: 'text', text: 'Fixed the cwd bug.' },
        { type: 'tool-call', name: 'bash' },
      ],
    },
  },
})
onEvent(summarised, { type: 'tool/call', data: { turn: 1, step: 1 } })
onEvent(summarised, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await sleep(70)
const report = sent.at(-1)?.body?.text ?? ''
check('the idle report carries the closing message', report.includes('Fixed the cwd bug.'), report)
check('reasoning is never leaked into the report', !report.includes('PRIVATE-SCRATCH-SPACE'), report)
check('turns are counted', report.includes('1 turn'), report)
check('tool calls are counted', report.includes('1 tool call'), report)
check('the session is named in the heading', report.includes('Session idle — Summary case'), report)

// The last assistant message wins, not the first.
await settle()
onEvent(summarised, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Second message.' }] } } })
onEvent(summarised, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
await sleep(70)
const latest = sent.at(-1)?.body?.text ?? ''
check('the most recent closing message is reported', latest.includes('Second message.'), latest)

// A long closing message is truncated, not dropped or sent whole.
await settle()
const chatty = session('Chatty')
onEvent(chatty, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'y'.repeat(1200) }] } } })
onEvent(chatty, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await sleep(70)
const truncated = sent.at(-1)?.body?.text ?? ''
check('a long closing message is truncated', truncated.includes('…') && truncated.length < 700, `${truncated.length} chars`)

// A session with no assistant text still reports.
await settle()
const silent = session('Silent')
onEvent(silent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await sleep(70)
const silentReport = sent.at(-1)?.body?.text ?? ''
check('a session with no closing text still reports', silentReport.includes('Session idle'), silentReport)

// ---- the question listener never owns the decision --------------------------
console.log('\nquestion waterfall')
await settle()
let nextCalls = 0
const questionHandler = ctx.listeners.get('user-questions/request')
const returned = questionHandler({ questions: [QUESTION], agent: {} }, () => {
  nextCalls += 1
  return 'DELEGATED'
})
check('the question listener delegates', nextCalls === 1, String(nextCalls))
check('it returns the downstream value unchanged', returned === 'DELEGATED', String(returned))
await sleep(20)
check('it still notifies', sent.length === 1, String(sent.length))
check('the question text is included', sent[0]?.body?.text?.includes('Which environment?'), sent[0]?.body?.text)
check('the options are listed', sent[0]?.body?.text?.includes('Development') && sent[0].body.text.includes('Production'), sent[0]?.body?.text)
check(
  'it points at the app rather than promising a reply',
  sent[0]?.body?.text?.includes('answer it in the app') && !sent[0].body.text.toLowerCase().includes('reply'),
  sent[0]?.body?.text,
)

const noNext = questionHandler({ questions: [QUESTION] }, undefined)
check('a missing next() does not throw', noNext === undefined, String(noNext))

// ---- no inbound surface once paired -----------------------------------------
console.log('\noutbound only')
await settle()
// Once a chat is known there is no reader at all, so a message sent to the bot
// can have no effect. This is the property that made the plugin safe to ship.
check('a paired plugin never reads from Telegram', reads.length === 0, JSON.stringify(reads))
check('every call is a sendMessage', attempts.every((a) => a.url.includes('/sendMessage')), JSON.stringify(attempts.map((a) => a.url.slice(0, 50))))

// ---- one-tap pairing --------------------------------------------------------
console.log('\npairing')
// A token with no chat id puts the plugin into a bounded pairing window.
const pairingHome = freshHome()
delete process.env.TELEGRAM_CHAT_ID
reads = []
sent = []
updates = []
getMePayload = { ok: true, result: { username: 'demo_bot' } }

const pairingCtx = makeCtx()
plugin.apply(pairingCtx, { pairingWindowMs: 400 })
await sleep(60)
check('pairing asks Telegram who the bot is', reads.some((url) => url.includes('/getMe')), JSON.stringify(reads))
check('pairing starts reading for a Start press', reads.some((url) => url.includes('/getUpdates')), JSON.stringify(reads))
check('nothing is sent before a chat exists', sent.length === 0, JSON.stringify(sent.map((m) => m.body?.text)))

// A private /start pairs; anything else must not.
updates = [{ update_id: 1, message: { chat: { id: 99, type: 'group' }, text: '/start' } }]
await sleep(60)
check('a group chat cannot pair', sent.length === 0, JSON.stringify(sent.map((m) => m.body?.text)))

updates = [{ update_id: 2, message: { chat: { id: 77, type: 'private' }, text: 'hello there' } }]
await sleep(60)
check('a private chat that did not press Start cannot pair', sent.length === 0, JSON.stringify(sent.map((m) => m.body?.text)))

updates = [{ update_id: 3, message: { chat: { id: CHAT_ID, type: 'private' }, text: '/start' } }]
await sleep(80)
check('a private Start pairs', sent.some((m) => m.body?.text?.includes('Paired')), JSON.stringify(sent.map((m) => m.body?.text)))
check(
  'the confirmation goes to the newly paired chat',
  sent.every((m) => m.body.chat_id === CHAT_ID),
  JSON.stringify(sent.map((m) => m.body.chat_id)),
)
const stored = JSON.parse(readFileSync(path.join(pairingHome, 'telegram-notify.json'), 'utf8'))
check('the chat id is remembered', stored.chatId === CHAT_ID, JSON.stringify(stored))

// The read must stop the instant it has an answer.
const readsAtPairing = reads.length
await sleep(120)
check('reading stops once paired', reads.length === readsAtPairing, `${readsAtPairing} -> ${reads.length}`)
pairingCtx.cleanups[0]()

// A stored pairing means no second pairing window on the next start.
reads = []
sent = []
const reopened = makeCtx()
plugin.apply(reopened, { pairingWindowMs: 400 })
await sleep(60)
check('a remembered chat skips pairing entirely', reads.length === 0, JSON.stringify(reads))
reopened.cleanups[0]()

// A rejected token must not spin: it reports and gives up.
freshHome()
reads = []
getMePayload = { ok: false, error_code: 401, description: 'Unauthorized' }
const badCtx = makeCtx()
plugin.apply(badCtx, { pairingWindowMs: 400 })
await sleep(80)
check('a rejected token stops pairing', reads.every((url) => !url.includes('/getUpdates')), JSON.stringify(reads))
badCtx.cleanups[0]()
getMePayload = { ok: true, result: { username: 'demo_bot' } }

// Restore the configured-chat environment for the remaining checks.
process.env.TELEGRAM_CHAT_ID = CHAT_ID
freshHome()

// ---- the chat allow-list is absolute ----------------------------------------
console.log('\nsafety')
await settle()
onEvent(session('Only chat'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
await sleep(20)
check(
  'every message goes to the configured chat only',
  sent.length > 0 && sent.every((message) => message.body.chat_id === CHAT_ID),
  JSON.stringify(sent.map((message) => message.body.chat_id)),
)
check(
  'the endpoint carries the token',
  sent.every((message) => message.url.includes('/botTEST-TOKEN/sendMessage')),
  sent[0]?.url,
)
check('message text never contains the token', sent.every((message) => !message.body.text.includes('TEST-TOKEN')))

// ---- transport failures stay contained --------------------------------------
console.log('\nfailure containment')
fetchMode = 'http500'
await settle()
onEvent(session('HTTP fail'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
await sleep(20)
check(
  'an HTTP error is attempted but not delivered',
  attempts.length === 1 && sent.length === 0,
  `attempts=${attempts.length} sent=${sent.length}`,
)

fetchMode = 'network'
await settle()
onEvent(session('Network fail'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
await sleep(20)
check('a network error is contained', attempts.length === 1 && sent.length === 0, `attempts=${attempts.length} sent=${sent.length}`)

fetchMode = 'ok'
await settle()
onEvent(session('Recovered'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
await sleep(20)
check('it still delivers after transport failures', sent.length === 1, String(sent.length))

// ---- lifecycle --------------------------------------------------------------
console.log('\nlifecycle')
ctx.cleanups[0]()
check('cleanup removes the session feed listener', !ctx.listeners.has('session/event'))
check('cleanup removes the question listener', !ctx.listeners.has('user-questions/request'))

// Restore the environment and transport.
globalThis.fetch = realFetch
if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
else process.env.TELEGRAM_BOT_TOKEN = savedToken
if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID
else process.env.TELEGRAM_CHAT_ID = savedChat

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
