# Contributing

Use Node.js 22 or newer. The package has no external dependencies, so you can run
`npm test` immediately after cloning it. `npm run selftest` is the same test command.
Run `node --check index.js`, `node --check selftest.mjs`, and `npm pack --dry-run`
before submitting a change.

Keep changes focused and describe the behavior they change. Add a self-test for a
behavior fix, using the fake host and fake transport rather than a real bot token.
Preserve the question waterfall's immediate delegation, contained transport
failures, and the absence of Telegram reads after pairing.

Include the Node and DeepSeek Harness versions used for any live integration
check. A passing fake-host test does not establish compatibility with every host
version. Documentation and configuration changes should describe their privacy
effects accurately.

Submit an issue or pull request on the repository hosting this project. Never
include credentials, pairing state, private session content, or unredacted debug
logs. For vulnerabilities, follow [SECURITY.md](SECURITY.md).
