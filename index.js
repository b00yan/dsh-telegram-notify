/**
 * Telegram notifications for DeepSeek Harness.
 *
 * Tells you when a turn fails, when a session has genuinely gone quiet, and when
 * an agent is waiting on a question. Setup is a token plus one tap on Start.
 *
 * It is **outbound only once paired**. The single exception is a bounded,
 * self-terminating pairing window that exists to learn your chat id, so the
 * `@BotFather` chat-id hunt is not part of setup. Outside that window the plugin
 * never reads from Telegram, so nothing sent to the bot can reach an agent.
 *
 * Answering a question from Telegram was built and removed. It cannot work in
 * this deployment: `dsh-tool-ask-user` runs in its default, non-timed mode, so
 * `ctx.userQuestions.ask()` waits indefinitely for the in-app card. A question
 * therefore never returns `pending` and never becomes `continued`, which is the
 * only state `ctx.userQuestions.answer()` accepts. See the README for what would
 * have to change.
 *
 * Two properties are load-bearing:
 *
 *   - It cannot break the agent. Sends are fire-and-forget with their own
 *     timeout; every failure is logged, never thrown into the loop.
 *   - It cannot be talked to. Only one configured chat is ever messaged, and
 *     nothing is ever read back.
 *
 * It deliberately imports nothing from the Harness: the durable session feed and
 * the question waterfall are the only surfaces used, so the bundle needs no peer
 * declarations and cannot break when an internal package is renamed.
 *
 * @module @local/telegram-notify
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'telegram-notify'

/** Quiet period after the last turn before a session is reported as done. */
const DEFAULT_IDLE_GRACE_MS = 45_000
/** Network budget for one send; a slow Telegram must never pile up. */
const DEFAULT_TIMEOUT_MS = 10_000
/** Telegram rejects messages over 4096 characters. */
const MAX_TEXT = 3800
/** Truncation limit for the closing assistant message in an idle report. */
const DEFAULT_SUMMARY_CHARS = 400
/** How long a one-tap pairing stays open waiting for the Start press. */
const DEFAULT_PAIRING_WINDOW_MS = 10 * 60 * 1000
/** Long-poll window while pairing; short, because pairing waits on a human. */
const PAIRING_POLL_SEC = 10
/** Delay after a failed pairing poll. */
const PAIRING_BACKOFF_MS = 5_000
/** Where the paired chat id is remembered, relative to DSH_HOME. */
const STATE_FILE_NAME = 'telegram-notify.json'
/** Turn-end kinds that mean the turn did not simply finish its work. */
const FAILURE_KINDS = new Set(['blocked', 'error', 'aborted', 'abandoned', 'max-tokens'])

/**
 * Read one value from config first, then the environment.
 *
 * @param config - the plugin row's config, already merged by the loader.
 * @param key - config key to prefer.
 * @param env - environment variable to fall back to.
 * @returns the trimmed value, or an empty string.
 */
function readSetting(config, key, env) {
  const fromConfig = config?.[key]
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
  const value = process.env[env]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * A short human label for a session, without depending on any internal shape.
 *
 * @param session - the session passed on the `session/event` feed.
 * @returns a title, the workspace directory name, or a generic fallback.
 */
function sessionLabel(session) {
  const title = session?.header?.title
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return path.basename(cwd)
  return session?.header?.id ?? session?.id ?? 'session'
}

const isFailure = (kind) => kind === null || kind === undefined || kind !== 'completed'

/** Sleep helper for the bounded pairing poll. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read the chat id remembered by an earlier pairing.
 *
 * Synchronous on purpose: `apply` is synchronous, and a tiny read at startup is
 * cheaper than making the whole plugin lifecycle async.
 *
 * @param stateFile - absolute path to the pairing state file.
 * @returns the stored chat id, or an empty string.
 */
function readStoredChatId(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    const chatId = parsed?.chatId
    return typeof chatId === 'string' ? chatId.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Remember a paired chat id so later restarts never re-pair.
 *
 * @param stateFile - absolute path to the pairing state file.
 * @param chatId - the chat that pressed Start.
 * @returns whether it was written.
 */
async function writeStoredChatId(stateFile, chatId) {
  try {
    await mkdir(path.dirname(stateFile), { recursive: true })
    // 0600: the file names a chat, and it lives beside credentials.
    await writeFile(stateFile, `${JSON.stringify({ chatId }, null, 2)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * Render the message for a finished turn.
 *
 * @param label - session label.
 * @param cwd - session working directory, when known.
 * @param turn - turn number, when known.
 * @param kind - turn-end reason kind, or null when the turn ended abnormally.
 * @returns the message text.
 */
function formatTurnEnd(label, cwd, turn, kind) {
  const noun = kind === null || kind === undefined ? 'ended abnormally' : `ended: ${kind}`
  return [
    `⚠️ Turn ${noun}`,
    `session: ${label}`,
    `turn: ${turn ?? '?'}`,
    cwd ? `cwd: ${cwd}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Pull the prose out of one committed assistant message.
 *
 * Verified against a real session log: `assistant/message` carries
 * `data.message.content`, an array whose blocks are `reasoning`, `text`, and
 * `tool-call`; only the `text` blocks are the agent's own words. Reasoning is
 * deliberately excluded — it is the model's scratch space, not its report.
 *
 * @param event - one `session/event` payload.
 * @returns the joined text blocks, or an empty string when there are none.
 */
function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim())
    }
  }
  return parts.join('\n\n')
}

/**
 * Render a duration as a short human string.
 *
 * @param ms - elapsed milliseconds.
 * @returns e.g. `4m 32s`, or an empty string when the duration is unknown.
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Render the message for a session that has gone quiet.
 *
 * This is the session's closing report: how long it ran, how many turns and tool
 * calls it took, and what the agent said last.
 *
 * @param state - the per-session state gathered from the event feed.
 * @param includeLastMessage - whether the agent's closing words may be included.
 * @param summaryChars - truncation limit for that text.
 * @returns the message text.
 */
function formatIdle(state, includeLastMessage, summaryChars) {
  const duration = formatDuration(state.endedAt - state.startedAt)
  const closing = includeLastMessage ? state.lastText.trim() : ''
  const lines = [
    `✅ Session idle${state.label ? ` — ${state.label}` : ''}`,
    [
      `${state.turns} turn${state.turns === 1 ? '' : 's'}`,
      state.failures > 0 ? `${state.failures} failed` : '',
      state.toolCalls > 0 ? `${state.toolCalls} tool call${state.toolCalls === 1 ? '' : 's'}` : '',
      duration,
    ]
      .filter(Boolean)
      .join(' · '),
    closing !== ''
      ? `\n${closing.length > summaryChars ? `${closing.slice(0, summaryChars)}…` : closing}`
      : '',
    state.cwd ? `\ncwd: ${state.cwd}` : '',
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/**
 * Render the message for a question that is waiting on a human.
 *
 * No reply is offered: this deployment's question tool can only be answered by
 * the in-app card, so promising a reply here would be a lie.
 *
 * @param request - the question request from the waterfall.
 * @returns the message text.
 */
function formatQuestion(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const lines = ['❓ Waiting for an answer — answer it in the app']
  for (const question of questions.slice(0, 5)) {
    const text = question?.question ?? question?.header ?? question?.text
    if (typeof text === 'string' && text.trim() !== '') lines.push(text.trim().slice(0, 300))
    const options = Array.isArray(question?.options) ? question.options : []
    for (const option of options.slice(0, 10)) {
      const optionLabel = typeof option?.label === 'string' ? option.label : option?.value
      if (typeof optionLabel === 'string' && optionLabel.trim() !== '') {
        lines.push(`  • ${optionLabel.trim().slice(0, 120)}`)
      }
    }
  }
  if (lines.length === 1) lines.push('(question payload had no readable text)')
  return lines.join('\n')
}

/**
 * Register the notification behavior.
 *
 * @param ctx - plugin context; `on`, `get`, and `effect` are the only members used.
 * @param config - the row's config from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const token = readSetting(config, 'token', 'TELEGRAM_BOT_TOKEN')
  const configuredChatId = readSetting(config, 'chatId', 'TELEGRAM_CHAT_ID')
  const idleGraceMs = Number.isFinite(config?.idleGraceMs) && config.idleGraceMs > 0
    ? config.idleGraceMs
    : DEFAULT_IDLE_GRACE_MS
  const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const summaryChars = Number.isFinite(config?.summaryChars) && config.summaryChars > 0
    ? config.summaryChars
    : DEFAULT_SUMMARY_CHARS
  // On by default: the closing message is what makes the report a summary rather
  // than a count. Set false to keep conversation content off Telegram entirely.
  const includeLastMessage = config?.includeLastMessage !== false
  const pairingWindowMs =
    Number.isFinite(config?.pairingWindowMs) && config.pairingWindowMs > 0
      ? config.pairingWindowMs
      : DEFAULT_PAIRING_WINDOW_MS

  const note = (level, message) => {
    const logger = ctx?.logger
    if (typeof logger?.[level] === 'function') logger[level](`[telegram-notify] ${message}`)
    else if (level === 'warn') console.warn(`[telegram-notify] ${message}`)
  }

  const dshHome = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '.', '.dsh')
  const stateFile = typeof config?.stateFile === 'string' && config.stateFile.trim() !== ''
    ? config.stateFile.trim()
    : path.join(dshHome, STATE_FILE_NAME)

  // Opt-in tracing. The Host keeps its own logger out of reach, so when a
  // notification does not arrive there is otherwise nothing to inspect.
  // `debugLog` names a file; `debug: true` uses <DSH_HOME>/telegram-notify-debug.log.
  const debugPath = readSetting(config, 'debugLog', 'TELEGRAM_NOTIFY_DEBUG')
    || (config?.debug === true ? path.join(dshHome, 'telegram-notify-debug.log') : '')
  const trace = (line) => {
    if (debugPath === '') return
    void appendFile(debugPath, `${new Date().toISOString()} ${line}\n`).catch(() => {})
  }

  if (token === '') {
    note('warn', 'TELEGRAM_BOT_TOKEN must be set (put it in ~/.dsh/.env); notifications are disabled')
    return
  }

  // Resolved once and owned by this closure: a one-tap pairing can fill the chat
  // in later, and every send reads it from here.
  const connection = {
    chatId: configuredChatId !== '' ? configuredChatId : readStoredChatId(stateFile),
  }
  const paired = configuredChatId !== ''
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`
  const pairingAbort = new AbortController()

  // Only reached when the token was supplied without a chat id.
  if (connection.chatId === '' && configuredChatId === '') void pair()

  /**
   * Send one message. Never rejects, so no caller needs a catch.
   *
   * @param text - message body, truncated to Telegram's limit.
   * @returns whether Telegram accepted the message.
   */
  async function send(text) {
    // Nothing to send to until a chat is paired; stay silent rather than guess.
    if (connection.chatId === '') return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetch(api('sendMessage'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: connection.chatId,
          text: text.slice(0, MAX_TEXT),
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        note('warn', `sendMessage failed: HTTP ${response.status} ${body.slice(0, 200)}`)
        trace(`send failed: HTTP ${response.status}`)
        return false
      }
      trace(`sent: ${JSON.stringify(text.slice(0, 60))}`)
      return true
    } catch (error) {
      note('warn', `sendMessage failed: ${error?.message ?? String(error)}`)
      trace(`send threw: ${error?.message ?? String(error)}`)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Learn the chat id from a Telegram Start press, then stop reading for good.
   *
   * This is the plugin's only inbound read. It exists to remove the manual
   * chat-id hunt, so it is deliberately narrow: it runs only while no chat is
   * paired, it accepts only a `/start` from a private chat, and it ends
   * permanently the moment one arrives. Everything after pairing is outbound.
   */
  async function pair() {
    let username = ''
    try {
      const response = await fetch(api('getMe'), { signal: pairingAbort.signal })
      const payload = await response.json()
      if (payload?.ok !== true) {
        note('warn', `pairing: Telegram rejected the token (${payload?.description ?? 'no detail'})`)
        return
      }
      username = typeof payload.result?.username === 'string' ? payload.result.username : ''
    } catch (error) {
      if (!pairingAbort.signal.aborted) {
        note('warn', `pairing: could not reach Telegram: ${error?.message ?? String(error)}`)
      }
      return
    }

    note('info', `pairing: open https://t.me/${username} and press Start (waiting up to ${Math.round(pairingWindowMs / 60000)} minutes)`)
    trace(`pairing: window open for ${pairingWindowMs}ms via @${username}`)

    const deadline = Date.now() + pairingWindowMs
    // offset stays 0 on purpose: a Start pressed before the Harness started is
    // still a valid pairing, and pairing the same chat twice is harmless.
    let offset = 0
    while (Date.now() < deadline && connection.chatId === '') {
      try {
        const response = await fetch(api(`getUpdates?timeout=${PAIRING_POLL_SEC}&offset=${offset}`), {
          signal: pairingAbort.signal,
        })
        const payload = await response.json()
        if (payload?.ok !== true) {
          trace(`pairing: getUpdates not ok: ${JSON.stringify(payload).slice(0, 160)}`)
          await sleep(PAIRING_BACKOFF_MS)
          continue
        }
        for (const update of payload.result ?? []) {
          if (typeof update?.update_id === 'number') offset = update.update_id + 1
          const message = update?.message
          if (message === undefined) continue
          if (message.chat?.type !== 'private') {
            trace('pairing: ignored a non-private chat')
            continue
          }
          const text = typeof message.text === 'string' ? message.text.trim() : ''
          if (!/^\/start\b/.test(text)) {
            trace('pairing: ignored a message that is not /start')
            continue
          }
          connection.chatId = String(message.chat.id)
          const stored = await writeStoredChatId(stateFile, connection.chatId)
          note('info', `pairing: paired with chat ${connection.chatId}${stored ? '' : ' (could not persist it)'}`)
          trace(`pairing: paired with chat ${connection.chatId}; reading stops here`)
          await send('✅ Paired. This chat now receives DeepSeek Harness notifications.')
          return
        }
      } catch (error) {
        if (pairingAbort.signal.aborted) return
        trace(`pairing: getUpdates failed: ${error?.message ?? String(error)}`)
        await sleep(PAIRING_BACKOFF_MS)
      }
    }
    if (connection.chatId === '') {
      note(
        'warn',
        `pairing: no Start received; open https://t.me/${username} and press Start, or set TELEGRAM_CHAT_ID in ~/.dsh/.env`,
      )
    }
  }

  /** Per-session quiet-period state, dropped once its report is sent. */
  const sessions = new Map()

  const stateFor = (session) => {
    let state = sessions.get(session)
    if (state === undefined) {
      state = {
        label: sessionLabel(session),
        cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : '',
        turns: 0,
        failures: 0,
        toolCalls: 0,
        lastText: '',
        startedAt: Date.now(),
        endedAt: Date.now(),
        timer: null,
      }
      sessions.set(session, state)
    }
    return state
  }

  const clearTimer = (state) => {
    if (state?.timer != null) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  const scheduleIdle = (session) => {
    const state = stateFor(session)
    clearTimer(state)
    state.timer = setTimeout(() => {
      state.timer = null
      // Drop the entry first: a report is stateless, and this bounds the map's
      // growth across a long-lived process.
      sessions.delete(session)
      if (state.turns === 0) return
      void send(formatIdle(state, includeLastMessage, summaryChars))
    }, idleGraceMs)
    state.timer.unref?.()
  }

  const stopEvents = ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      // Work resumed; the session is not done after all.
      const state = sessions.get(session)
      if (state !== undefined) clearTimer(state)
      return
    }

    if (event?.type === 'assistant/message') {
      // Kept for the closing report. Reasoning blocks are ignored: the agent's
      // own words are the summary, not its scratch space.
      const text = assistantText(event)
      if (text !== '') stateFor(session).lastText = text
      return
    }

    if (event?.type === 'tool/call') {
      stateFor(session).toolCalls += 1
      return
    }

    if (event?.type !== 'turn/end') return

    const kind = event?.data?.reason?.kind ?? null
    const state = stateFor(session)
    state.turns += 1
    state.endedAt = Date.now()
    if (isFailure(kind)) {
      state.failures += 1
      const turn = event?.data?.turn
      void send(formatTurnEnd(state.label, state.cwd, turn, kind))
    }
    scheduleIdle(session)
  })

  // Never owns the decision: announce, then hand straight back to the shipped
  // answerer. A listener that awaited a human here would freeze the live
  // question card until the phone answered.
  const stopQuestions = ctx.on('user-questions/request', (...args) => {
    const next = args.at(-1)
    const request = args[0]
    const questions = Array.isArray(request?.questions) ? request.questions : []
    trace(`waterfall fired: questions=${questions.length}`)
    void send(formatQuestion(request)).catch((error) => {
      note('warn', `question notification failed: ${error?.message ?? String(error)}`)
    })
    return typeof next === 'function' ? next() : undefined
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      pairingAbort.abort()
      stopEvents?.()
      stopQuestions?.()
      for (const state of sessions.values()) clearTimer(state)
      sessions.clear()
    })
  }

  note(
    'info',
    connection.chatId === ''
      ? 'waiting for one-tap pairing (no chat configured yet)'
      : `notifications enabled for chat ${connection.chatId} (outbound only${paired ? ', paired from configuration' : ', paired earlier'})`,
  )
  trace(
    `apply: chat=${connection.chatId || '(unpaired)'} paired=${paired} idleGraceMs=${idleGraceMs} summaryChars=${summaryChars} debugLog=${debugPath}`,
  )
}
