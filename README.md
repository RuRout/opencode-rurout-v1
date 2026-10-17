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

### Windows (PowerShell)

The intended one-line installer command for the standalone V1 release is:

```powershell
& ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('https://rurout.ru/install.ps1'))) -Cli opencode1
```

This command is the installer integration target, not a claim that this source
revision or its archive is already published. Native Windows loading and live
model requests have not been verified by the bundle checks. A real V1 loader
smoke test and publication of the matching archive/installer are separate release
steps.

The installer uses this layout inside the OpenCode config directory:

```text
plugins/
  rurout-connect.js             # export { default } from './rurout-connect/index.js';
  rurout-connect/
    index.js                   # standalone ESM bundle
    package.json               # type: module; no dependencies
```

V1 auto-loads `plugins/*.{js,ts}`, not nested directories. The top-level wrapper
is therefore required; the nested bundle is not a second plugin entrypoint.
`@opencode-ai/plugin/tool` and Zod are bundled into `index.js`: installation does
not require npm/Bun to resolve those packages or install plugin dependencies.
This does not change OpenCode's own provider SDK requirements.

### macOS / Linux (archive only)

Status: **under verification**. The shell installer (`install.sh --cli opencode1`)
is not supported yet. Release archives are available for manual testing; use
the layout above rather than unpacking only into a nested directory:

```sh
curl -fsSLO https://rurout.ru/downloads/connect/rurout-opencode-v1-<version>.tar.gz
curl -fsSL https://rurout.ru/downloads/connect/SHA256SUMS | grep rurout-opencode-v1
shasum -a 256 rurout-opencode-v1-<version>.tar.gz   # must match the line above
```

No npm package is published. The future shell installation command is
`curl -fsSL https://rurout.ru/install.sh | sh -s -- --cli opencode1`; it is not
currently an installation method for V1.

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
npm run release:test   # packs twice, checks sha256, imports an isolated installation
```

The archive is deterministic (sorted names, fixed mtime/owner/mode, `gzip -n`):
the same commit and toolchain always give the same sha256. It holds
only the standalone `dist/index.js` bundle and a minimal `package.json` with no
runtime dependencies. The build runs TypeScript first (including declarations
and the separate modules used by unit tests), then esbuild replaces
`dist/index.js` with an ESM bundle targeting Node 20. Node builtins stay external.
Declarations, other compiled modules and build metadata are not shipped.

`release:test` also checks that the bundle includes the tool helper and Zod and
has no external imports other than Node builtins. It extracts the archive
outside the repository, adds the auto-loader wrapper, rejects external package
resolution and imports the plugin with only a default function export. The
offline check exercises tool schema construction without making gateway/model
requests; it is not a live Windows or OpenCode loader test.
