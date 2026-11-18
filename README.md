# Forge — a GitHub-compatible forge in one Node.js process

[![Competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![Rank](https://make.fun/badge/github-core-clone-01/Avapage/makefun-github-core-clone-01-r3/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![Reward](https://make.fun/badge/github-core-clone-01/Avapage/makefun-github-core-clone-01-r3/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Entry for [github-core-clone-01 on make.fun](https://make.fun/bounty/github-core-clone-01).

A standalone GitHub-compatible forge in a single Node.js process, standard library
only — no dependencies, no install step. It serves four surfaces over one in-memory
store, so an object created through any of them is the same object through all:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` including shallow clones and
  deepening) and protocol v0 (`fetch`, `receive-pack` with report-status and
  side-band-64k), packfiles with delta resolution, byte-exact object round-trips.
- **REST v3 subset** — repositories, contents API, git refs, branches, commits,
  labels, issues, comments, pull requests (diff, three-way merge with merge / squash
  / rebase), cursor-style `Link` pagination.
- **GraphQL v4 subset** — viewer/repository/issue/pull-request reads, the gh
  feature-detection introspection probes, cursor pagination, mutations
  (create/close/reopen issue, create/merge pull request, add comment), Relay
  `node(id:)` with opaque stable global ids, and operation batching.
- **MCP at `/mcp`** — `server/discover` (revision 2026-07-28) plus the legacy
  `initialize` handshake, and 19 tools over the same store (repos, issues, comments,
  pull requests, branches, files, commits).

## Run

```sh
node --experimental-strip-types main.ts
```

The server listens on an ephemeral port. When `$MAKEFUN_ENV_URL` is set it registers
its port with `POST $MAKEFUN_ENV_URL/register` and polls `$MAKEFUN_ENV_URL/done`
until the trial ends, per the competition's entry contract. Requests authenticate
with `Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>`.

## Design notes

- One process, one store: git objects, refs, issues and pull requests live in maps;
  pull requests share the issue number space, as on GitHub.
- Hot paths are allocation-light: the issue read path serves a cached serialization,
  pack building is a single pass with no deltas, and routing is plain segment
  matching — built to stay fast on the benchmark's push / clone / read / write
  workloads.
- Deterministic state: a logical clock stamps every record, so a replayed request
  sequence reproduces the same bytes.

## License

MIT — see [LICENSE](LICENSE).
