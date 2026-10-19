# @omp/omniroute-provider

OmniRoute gateway support for [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`):
an OpenAI-compatible provider named `omniroute`, plus two tools —
`omniroute_web_search` and `omniroute_web_fetch`.

This is an **omp-native port** of `@philogag/pi-provider-omniroute`. It targets the
omp extension API only; pi (`@earendil-works/*`) compatibility is intentionally
not kept.

## Install

As a workspace package (this repo):

```bash
pnpm install
```

In omp, extensions are discovered from a directory containing a `package.json`
with an `omp.extensions` array (this package declares `"omp": { "extensions":
["src/index.ts"] }`). Point omp at the package directory, or copy it into
`~/.omp/agent/extensions/`.

## Configure

1. Point the extension at your gateway. The base URL resolves in this order:
   - `omniroute.json` → `baseUrl` in the omp agent dir
   - `OMNIROUTE_BASE_URL`
   - `http://localhost:20128/v1`
2. Authenticate once with `/login omniroute` (the login flow opens the OmniRoute
   dashboard and asks for an API key), or export `OMNIROUTE_API_KEY`. A stored
   `/login` key wins over the env var.
3. Optional: `/omniroute-settings` opens a menu for the default web-search
   provider, the default web-fetch provider, and the base URL. The search
   submenu lists what the gateway actually has configured (`GET /search`) and
   falls back to the static provider ids when the gateway is unreachable or the
   request is unauthenticated.

The extension config lives at `<agent dir>/omniroute.json`:

```json
{
  "baseUrl": "http://localhost:20128/v1",
  "search": { "provider": "brave-search" },
  "fetch": { "provider": "jina-reader" }
}
```

`<agent dir>` is `~/.omp/agent` for the default profile, or
`~/.omp/profiles/<name>/agent` under `omp --profile <name>`.

## Tools

| Tool | Endpoint | Notes |
| --- | --- | --- |
| `omniroute_web_search` | `POST /search` | `web` / `news`, provider + result-count + filter passthrough, up to 20 000 chars of formatted results |
| `omniroute_web_fetch` | `POST /web/fetch` | `markdown` / `html` / `links` / `screenshot`, depth 0–2, selector wait, up to 40 000 chars |

Both tools fall back to the configured default provider when the call omits
`provider`, and a stale or unknown configured value (`auto`, a provider the
gateway dropped) is ignored rather than forwarded.

## Differences from the pi build

| pi build | this port |
| --- | --- |
| `Provider` object with `getModels` + `refreshModels` | `ProviderConfig` with the native `fetchDynamicModels` factory (omp caches the catalog, 24 h TTL) |
| provider `stream` / `streamSimple` wrappers carrying telemetry | removed — no telemetry injection needed |
| settings via a custom TUI overlay component | omp's built-in `ui.select` / `ui.input` dialogs (live gateway catalog instead of a rendered SelectList) |
| config in pi `settings.json` + `auth.json` | one extension-owned `omniroute.json` in the omp agent dir |
| `typebox` package + `prepareArguments` hook | injected `pi.typebox` schema builder; argument defaults resolved in `execute` |
| `defineTool` | plain `ToolDefinition` objects built by `createSearchTool` / `createFetchTool` |

### What did not carry over

**Usage telemetry is dropped.** The pi build wrapped streaming to read the
`X-OmniRoute-*` response headers and rewrite the assistant message's cost.
OmniRoute emits those values as trailing SSE comment lines inside the response
body, omp's `after_provider_response` event only exposes status/headers, and
omp's `assistant_message` rewrite hook cannot touch cost — so there is no place
to surface them. Model rows therefore report zero per-token cost.

## Development

```bash
pnpm run typecheck   # tsc --noEmit
pnpm run test        # node --test (src/ imports are type-only, so no harness is loaded)
```

Layout: `src/provider.ts` (provider identity, model mapping, discovery),
`src/config.ts` (agent-dir config store), `src/tools/*` (HTTP helpers and the
two tools), `src/index.ts` (extension entry).
