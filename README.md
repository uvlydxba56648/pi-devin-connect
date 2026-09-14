# pi-devin-connect

Use **Devin (Cognition) models** — `swe-2`, `swe-2-max`, `claude-*`, `gemini-*`, and the rest of the account's model catalog — directly inside [Pi](https://github.com/earendil-works/pi-coding-agent).

This extension talks to Devin's Connect-RPC endpoint (`server.codeium.com`) natively — the same protocol surface the official `devin` CLI uses. No local proxy, no OpenAI-compat shim, no extra process.

## Features

- **All account models** — catalog is fetched live from `GetCliModelConfigs` at load time (283+ variants, thinking-level grouped). `/devin-refresh` re-pulls it.
- **Streaming**: text, thinking blocks, tool calls, usage, model resolution (`actual_model_uid`).
- **`/login devin`** — in-Pi PKCE login: prints the Devin sign-in URL, you paste back the code, the extension exchanges it and stores the credential in `~/.local/share/devin/credentials.toml` — **shared with the real `devin` CLI** (either side can log in/out for both).
- **`/devin-status`** — account name, plan, daily/weekly quota %, credit balances, reset times.
- Honors `HTTPS_PROXY` / `HTTP_PROXY` (CONNECT tunnel) for the upstream connection.

## Install

Copy the directory into Pi's extension path:

```bash
git clone <this-repo> ~/.pi/agent/extensions/devin-connect
```

then `/reload` (or restart pi).

Or as an npm package in pi's extension config:

```bash
pi install pi-devin-connect   # once published
```

## Auth

Two ways, same credential file:

1. `devin auth login` with the official CLI — we read `windsurf_api_key` from `~/.local/share/devin/credentials.toml`.
2. `/login devin` inside Pi — PKCE paste-code flow; writes the same file so the CLI sees it too.

Token precedence: `DEVIN_TOKEN` / `WINDSURF_API_KEY` env → Pi OAuth credential → credentials.toml.

## Commands

| Command | What it does |
|---|---|
| `/login devin` | PKCE login (browser sign-in → paste code) |
| `/devin-status` | Plan / quota / credits / catalog summary |
| `/devin-refresh` | Re-fetch the live model catalog |

## Notes

- Requires a Devin account with CLI access (the `can_use_cli` flag).
- The extension reports itself as the installed CLI version (reads `~/.local/share/devin/cli/_versions/current`) so requests look like a current chisel build.
- Debug log: `~/.pi/agent/logs/devin-connect.log` (request timings, catalog loads, stream phases — no message contents).
- **Unofficial integration.** It sends the same Connect-RPC calls the CLI sends, but you're responsible for complying with Cognition's terms of service for your account.

## Files

```
index.ts            provider + commands + OAuth registration (pi.extensions entry)
src/stream.ts       GetChatMessage request builder + frame decoder (thinking/tool calls/usage)
src/connect.ts      Connect-RPC transport (unary + server-streaming envelopes, proxy CONNECT)
src/catalog.ts      GetCliModelConfigs → Pi model list (+ router AssignModel resolution)
src/credentials.ts  credentials.toml read/write, token normalization, client identity
src/auth.ts         PKCE flow, GetUserStatus → account/plan/quota parsing
src/proto.ts        minimal protobuf wire encoder/decoder (no deps)
src/log.ts          JSON-lines debug log
```
