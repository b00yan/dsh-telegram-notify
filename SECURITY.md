# Security and privacy

Keep the bot token outside this repository, preferably in `$DSH_HOME/.env`
(default `~/.dsh/.env`). Restrict access to that file. The plugin can also accept
`token` in its configuration, but configuration files are a poor home for secrets.
Never share real tokens, pairing state, or debug logs in public issues.

Notifications go to Telegram's servers. They include session labels, working
directories, turn outcomes, question text/options, and, by default, the latest
assistant text. `includeLastMessage: false` omits assistant text only; other
notification content still leaves the machine. Reasoning blocks are excluded.
The optional debug log contains chat identifiers and message excerpts.

When no chat is configured or remembered, pairing accepts the first private
`/start` message found during its polling window, including a previously queued
message. It does not authenticate that sender as the person running the Harness.
Use a bot you control, and set `TELEGRAM_CHAT_ID` explicitly if you need a fixed
recipient from startup. Use a dedicated bot; other consumers of its updates can
interfere with pairing. Once paired, the plugin stops reading Telegram and sends
to that single chat. Replies cannot answer Harness questions.

The default pairing window is ten minutes, but the deadline is checked between
requests. It is not a hard timeout for an in-flight Telegram request. Notification
sends have their own timeout and errors are caught; there is no delivery retry or
durable queue. Cleanup aborts pairing and removes listeners.

Pairing state is written with mode `0600` when a file is created. Keep the state
directory private; an existing file's permissions depend on its prior permissions
and the operating system. To change recipients, set `TELEGRAM_CHAT_ID` or remove
the stored state deliberately and restart. A bot token is a credential; revoke it
through Telegram if exposed.

For a suspected vulnerability, use the repository host's private vulnerability
reporting feature if available. If it is unavailable, open a public issue that
only requests a private reporting channel, without exploit details or secrets.
No private contact address or guaranteed response time is established by this
project.
