# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Alfonova-Node/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Alfonova-Node/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process — standard library
only, no dependencies, no git binary, no network access at runtime.

Built for the [make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01).

## What it speaks

- **REST v3** (`/api/v3/`): repositories, branches, commits, contents, labels,
  issues, comments, pull requests, files and squash merges, with GitHub-style
  status codes, JSON bodies, `Link` pagination and `X-GitHub-Request-Id`.
- **GraphQL v4** (`POST /api/graphql`): viewer, repository, issues and
  pull-request connections (cursor pagination, states, orderBy), `node(id:)`
  with global Relay ids, `__type` introspection, and the create/close/merge/
  comment mutations — including batched operation arrays.
- **MCP** (`POST /mcp`): JSON-RPC 2.0 over streamable HTTP, modern
  `server/discover` (revision `2026-07-28`) and the legacy `initialize`
  handshake; tools for repos, issues and pull requests whose effects are
  visible over REST.
- **Git smart HTTP** (`/<owner>/<repo>.git/`): protocol v2 and v0
  upload-pack (ls-refs, fetch, shallow/deepen), v0 receive-pack with
  per-ref report-status and non-fast-forward refusal. Packfiles are parsed
  and generated from scratch (`node:zlib`, `node:crypto`), including
  OFS_DELTA / REF_DELTA, annotated tags and side-band-64k.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts [port]
```

With `MAKEFUN_ENV_URL` set, the server registers its ephemeral port with the
harness and exits when the trial is done; without it, it serves standalone
on the given port (default: ephemeral) until stopped.

## Layout

- `main.ts` — entrypoint and harness lifecycle
- `app.ts` — HTTP server, auth, routing
- `store.ts` — in-memory store and git object model (sha1, trees, commits,
  tags, reachability, merge-base, diffs)
- `git.ts` — pkt-lines, packfiles, smart HTTP
- `rest.ts` — REST v3 handlers
- `graphql.ts` — GraphQL v4 lexer/parser/executor
- `mcp.ts` — MCP JSON-RPC handler and tools

State is in-memory and deterministic: fixed timestamps, sequential
issue/PR numbers, stable ordering. Requires Node >= 22.18.
