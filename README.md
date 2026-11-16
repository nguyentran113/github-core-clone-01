# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nguyentran113/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nguyentran113/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: git smart HTTP
(protocol v2 ls-refs/fetch with shallow support, v0 receive-pack with fast-forward checks and
report-status), the REST v3 surface (repositories, branches, commits, contents, labels, issues,
comments, pull requests and squash merges), a GraphQL v4 endpoint with introspection, and an MCP
endpoint (server/discover plus the legacy initialize handshake) whose six tools act on the same
store as REST. State is in memory; ids and timestamps come from counters and a logical clock, so
runs are deterministic.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` owns the harness lifecycle: it binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` and exits 0. `app.ts` builds the
server; `git.ts` is the object model and wire plumbing, `store.ts` the shared state, `graphql.ts`
and `mcp.ts` the two agent-facing surfaces.

---

<sub>Entered on [make.fun](https://make.fun/?ref=am378nqn&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
