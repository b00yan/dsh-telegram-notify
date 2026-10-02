# dsh-telegram-notify

A Telegram notification plugin for DeepSeek Harness.

Sends a Telegram message when a turn fails, when a session has genuinely gone
quiet, and when an agent is waiting on a question. Setup is a token plus one tap on
**Start** — no chat-id hunting.

It is **outbound only once paired**: apart from the initial pairing window, it
never reads from Telegram, so nothing you send the bot can reach an agent.

| Message | When |
| --- | --- |
| ⚠️ Turn ended | A turn ends with a reason other than `completed` — `blocked`, `error`, `aborted`, `abandoned`, `max-tokens`, or a null reason (an abnormal end). |
| ✅ Session idle | No turn has started for `idleGraceMs` after the last one finished. This is the session's closing report — see below. |
| ❓ Waiting for an answer | An agent asked a question. The options are listed so you can read it at a glance; **answer it in the app**. |

## The session report

The idle message is a summary, not just a ping:

```
✅ Session idle — example-project
12 turns · 45 tool calls · 4m 32s

Fixed the default cwd bug and added seven regression checks covering the
session directory each tool falls back to…

cwd: /workspace/example-project
```

- **Turns, tool calls, duration** — counted from the durable event feed, not
  estimated. `failures` appears alongside turns only when there were any.
- **The closing message** — the text of the session's most recent
  `assistant/message`. Blocks of type `reasoning` are deliberately excluded: the
  agent's own words are the summary, not its scratch space.
- **Truncation** — the closing text is cut at `summaryChars` with an ellipsis.

**The plugin sends notification content to Telegram.** By default this includes
the latest assistant text, session title, working-directory path, turn outcomes,
and question text/options. Set `includeLastMessage: false` to omit assistant text;
metadata and question content are still sent. Review [SECURITY.md](SECURITY.md)
before enabling it for sensitive work.

## Compatibility and installation

The existing integration was verified with DeepSeek Harness `0.2.0-rc.2`.
The standalone self-test uses a fake host and transport; it does not qualify other
Harness versions or test live Telegram delivery. Use Node.js 22 or newer. This
package has no external dependencies.

Clone or download this project's repository into a local directory, then run:

```sh
cd /path/to/dsh-telegram-notify
npm test
```

In the Harness Plugin Manager, choose **Add plugin**, select the absolute path to
that directory (for example `/path/to/dsh-telegram-notify`), choose **Enable now**,
and restart the Harness. The profile's `package.json` and `cordis.patch.yml` are
owned by the Plugin Manager; configure the plugin through its supported workflow.

## Development

```sh
npm test
npm run selftest
npm pack --dry-run
```

Both test commands run the same self-contained checks. CI runs them on Node.js 22
and 24. No `npm install` or lockfile is required because there are no dependencies.

## Setup: token, then one tap

Only the **token** has to be pasted anywhere. Put it in **`~/.dsh/.env`**:

```
TELEGRAM_BOT_TOKEN=<your-bot-token>
```

The Harness layers `$DSH_HOME/.env` into the host process at startup. The default
is `~/.dsh/.env`; keep credentials outside your checkout and restrict file access.
A project `.env` is read too, but only when the host's working directory is that
project — do not rely on it. `.env.local` is **not** read by the host at all.

Then restart the Harness, open `https://t.me/<your_bot>`, and press **Start**:

```
INFO  [telegram-notify] pairing: open https://t.me/your_bot and press Start (waiting up to 10 minutes)
INFO  [telegram-notify] pairing: paired with chat <your-chat-id>
```

You get a `✅ Paired` message in Telegram, and the chat id is written to
`$DSH_HOME/telegram-notify.json` (default `~/.dsh/telegram-notify.json`). A new
state file is created with mode 0600; later restarts reuse it while it remains
readable and contains a chat id.

There is no `@BotFather` chat-id hunt: no `getUpdates` call by hand, no copying a
number out of a JSON blob. You do not need `TELEGRAM_CHAT_ID` at all.

`TELEGRAM_CHAT_ID` still works if you prefer to set it explicitly — a configured
chat skips pairing entirely, and the plugin then never reads from Telegram.

Restart the Harness after changing the environment: layers are read at startup, not
per turn. Changing this plugin's code also needs a restart, because the Host caches
the loaded module generation.

With no token the plugin registers nothing and logs one warning. It never guesses a
recipient, and it never sends while unpaired.

## Pairing is the only read

Everything else in this plugin is outbound. The pairing window is the single
exception, and it is deliberately narrow:

- **Only while unpaired.** A chat from the environment or from
  `telegram-notify.json` skips it completely — no `getMe`, no `getUpdates`.
- **Only a private `/start`.** A group chat cannot pair, and neither can a private
  message that is not `/start`. Both are ignored and traced.
- **A nominal `pairingWindowMs` window** (10 minutes by default). The deadline is
  checked between requests; it does not impose a hard timeout on an in-flight
  pairing request. After the loop ends, no more reads are started.
- **It stops the instant it succeeds.** The check that the read count stops growing
  is in the self-test.

Pairing accepts the first private `/start` found, including a queued message; it
does not authenticate the sender as the Harness operator. Use a bot you control,
or set `TELEGRAM_CHAT_ID` explicitly to choose the recipient before startup.

## Answer questions in the Harness

The current plugin sends notifications only. It does not implement a Telegram
reply handler or forward bot messages to an agent. Question notifications list
the choices and direct you to answer in the Harness app, regardless of the host's
question-tool configuration.

## Behaviour worth knowing

- **Non-blocking by construction.** Sends are fire-and-forget with a 10 s timeout,
  and every failure path is caught and logged. A Telegram outage cannot slow or
  break an agent turn.
- **One chat, always.** Every message goes to the configured `chat_id`.
- **The question listener does not own the decision.** It is a
  `user-questions/request` waterfall listener that announces the question and
  immediately returns `next()`, so the in-app question card keeps working. A
  listener that awaited a human here would freeze it.
- **No inbound surface once paired.** Asserted by the self-test rather than
  assumed: the fake transport records reads separately from sends, and a check fails
  if a *paired* plugin ever calls `getUpdates`. Pairing itself is covered by its own
  section, including that reading stops the moment a chat is learned.
- **No Harness imports.** The bundle uses only `ctx.on` and Node builtins, so it
  needs no `peerDependencies` declaration. It still depends on the host event and
  lifecycle contracts listed above. The cost is no `Config` schema: the row's
  config is validated defensively instead of by the loader.

## Configuration

Set on the plugin row in `cordis.patch.yml`:

| Field | Default | Meaning |
| --- | --- | --- |
| `idleGraceMs` | `45000` | Quiet period after the last turn before the session counts as done. |
| `includeLastMessage` | `true` | Include the closing assistant message in the session report. Set `false` to omit assistant text; question content and metadata still go to Telegram. |
| `summaryChars` | `400` | Truncation limit for that closing message. |
| `timeoutMs` | `10000` | Network budget for one message. |
| `debug` | `false` | Trace to `<DSH_HOME>/telegram-notify-debug.log`. Also `debugLog: <path>`, or `$TELEGRAM_NOTIFY_DEBUG`. |
| `pairingWindowMs` | `600000` | How long one-tap pairing waits for the Start press before giving up. |
| `stateFile` | `<DSH_HOME>/telegram-notify.json` | Where the paired chat id is remembered. |
| `token` | `$TELEGRAM_BOT_TOKEN` | Overrides the environment; prefer the environment. |
| `chatId` | `$TELEGRAM_CHAT_ID` | Set it to skip pairing entirely; otherwise learned by one tap. |

Raise `idleGraceMs` on sessions that pause between turns.

The bundled patch starts with `debug: false`. Enable it temporarily when diagnosing
missing notifications, then turn it off. The trace includes chat identifiers and
message excerpts; treat it as sensitive.

## Test coverage

```
npm test
```

55 checks driving `apply()` with a fake context and a fake `fetch`:

- **Configuration** — a plugin with no token registers nothing, sends nothing, and
  never reads; a chat set in the environment also skips pairing entirely.
- **Pairing** — a token alone opens the window; `getMe` names the bot; a group chat
  cannot pair; a private message that is not `/start` cannot pair; a private
  `/start` pairs, is confirmed to that chat, and is remembered on disk; reading stops
  the moment it succeeds; a remembered chat skips pairing on the next start; and a
  rejected token gives up instead of spinning.
- **Turn outcomes** — a completed turn is silent until the quiet period elapses;
  every failure kind, including a null reason, is reported at once; `turn/start`
  cancels a pending idle report.
- **Session summary** — the closing message is carried into the report, the most
  recent one wins over earlier ones, long text is truncated, `reasoning` blocks
  are never leaked, turns and tool calls are counted, and a session with no
  assistant text still reports.
- **Waterfall** — the question listener always delegates, returns the downstream
  value unchanged, still notifies, lists the options, and points at the app
  instead of promising a reply.
- **Outbound only once paired** — a paired plugin never reads from Telegram, and
  every call it makes is a `sendMessage`.
- **Safety** — every message goes to the configured chat; the token never appears
  in message text.
- **Containment** — HTTP and network failures are swallowed and do not poison later
  notifications; cleanup removes every listener.

## License

[MIT](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
