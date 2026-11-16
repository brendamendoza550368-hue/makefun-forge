# makefun-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/brendamendoza550368-hue/makefun-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/brendamendoza550368-hue/makefun-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in TypeScript: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP served from one process over its own store — no git binary, no outside services, no UI.

## Run it

```sh
npm start
```

The forge binds an ephemeral port, registers it with the trial environment (`MAKEFUN_ENV_URL`), serves until the environment reports done, then exits 0. Node >= 22.18 required.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
