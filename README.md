# RuRout for OpenCode 1.x

OpenCode **1.x** provider plugin for [RuRout](https://rurout.ru) — your gateway key becomes a first-class provider in `/models`.

> For OpenCode **2.x** see [opencode-rurout-v2](https://github.com/RuRout/opencode-rurout-v2).

## What the client gets

- New `RuRout` provider in the OpenCode model picker, next to the built-ins.
- Model list discovered live from `GET /v1/models` with the active key — each client sees exactly the models that key allows.
- Provider and model names include the admin-given key name from `GET /v1/sub2api/billing` (e.g. `RuRout Germes`).
- `/connect rurout` stores the key in OpenCode's auth system.
- The active key is checked on startup and hourly without a restart. A successful refresh replaces the list, including removing models unavailable to the key. Stale `~/.cache/opencode-rurout/models-*.json` files are deleted on startup.

## Install (OpenCode 1.x only)

Status: **under verification**. The RuRout installer (`install.sh`) does not
install this plugin yet, because loading a multi-file plugin with its
`@opencode-ai/plugin` dependency from the global plugins directory has not been
confirmed on a live OpenCode 1.x. The release archive is published for testing:

```sh
curl -fsSLO https://rurout.ru/downloads/connect/rurout-opencode-v1-<version>.tar.gz
curl -fsSL https://rurout.ru/downloads/connect/SHA256SUMS | grep rurout-opencode-v1
shasum -a 256 rurout-opencode-v1-<version>.tar.gz   # must match the line above
```

No npm package is published. When OpenCode 1.x support is released it will be
installed with `curl -fsSL https://rurout.ru/install.sh | sh -s -- --cli opencode1`.

Once the plugin is loaded, inside OpenCode:

```
/connect
```

Select `rurout`, paste the gateway API key. Restart OpenCode, then `/models` → pick a `rurout/*` model.

Environment alternative (servers / CI):

```sh
export RUROUT_API_KEY=sk-...
opencode
```

## Custom gateway address

```sh
export RUROUT_BASE_URL=https://rurout.ru/v1
```

By default the plugin tries `https://rurout.ru/v1` and, if that address is
unreachable (for example a VPN or network blocks the domain), falls back to
`https://rurout.online/v1`; chat and image requests then use whichever address
answered. Existing installations using `https://rurout.online:9443/v1` may keep
it via `RUROUT_BASE_URL`. An explicit address (`RUROUT_BASE_URL` or a provider
`baseURL` that is not one of the default domains) is used as-is, without
failover.

## How it works

The v1 `config` hook registers the `rurout` provider with `@ai-sdk/openai-compatible`, fetches `GET /v1/models` with the active key, preserves the exact IDs returned by the gateway, and fills in context/pricing metadata. The `auth` hook adds `/connect rurout`.

## Build the release archive

```sh
npm ci && npm run build
npm run release:pack   # writes release/rurout-opencode-v1-<version>.tar.gz and prints its sha256
npm run release:test   # builds twice and fails if the sha256 differs
```

The archive is deterministic (sorted names, fixed mtime/owner/mode, `gzip -n`):
the same commit and toolchain always give the same sha256. It holds
`dist/*.js` and a minimal `package.json` that declares the `@opencode-ai/plugin`
dependency.
