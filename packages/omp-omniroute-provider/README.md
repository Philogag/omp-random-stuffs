# @philogag/omp-provider-omnirouter

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

### Guided setup (recommended)

```
/login-omniroute
```

Two prompts: the gateway URL, prefilled with the live value so an existing base
URL can be corrected in place, then an API key stored through omp's own
credential pipeline — the same store `/login` writes to, so this extension never
persists secrets itself. The key prompt runs every time, so re-running the
command replaces an existing key. Afterwards it verifies the gateway
(`GET /models`), reports how many models it advertises, and points at the
web-tool settings.

### Manual setup

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
| provider `stream` / `streamSimple` wrappers carrying telemetry | rebuilt on a custom api (`omniroute-openai-completions`) — see [Cost telemetry](#cost-telemetry) |
| settings via a custom TUI overlay component | omp's built-in `ui.select` / `ui.input` dialogs (live gateway catalog instead of a rendered SelectList) |
| config in pi `settings.json` + `auth.json` | one extension-owned `omniroute.json` in the omp agent dir |
| `typebox` package + `prepareArguments` hook | injected `pi.typebox` schema builder; argument defaults resolved in `execute` |
| `defineTool` | plain `ToolDefinition` objects built by `createSearchTool` / `createFetchTool` |
| env-var-only auth (`envApiKeyAuth`) | `/login-omniroute`, a prefilled base-URL prompt plus a key prompt on top of omp's `authStorage.oauth.login`; `OMNIROUTE_API_KEY` stays the fallback rank |

## Cost telemetry

OmniRoute bills per request and reports what it charged as `X-OmniRoute-*`
**SSE comment lines inside the response body** (`: x-omniroute-response-cost=…`),
not as headers. omp's `after_provider_response` only exposes status/headers and
its assistant-message rewrite hook cannot touch cost, so the values are
unreachable through the event surface.

Instead the provider registers a **custom api**:

```
ProviderConfig.api = "omniroute-openai-completions"   // custom name — built-in names are reserved
ProviderConfig.streamSimple → wraps the real openai-completions dispatch
```

On each request that means:

1. `streamSimple` injects a byte-transparent `fetch` wrapper
   (`src/telemetry/omniroute-telemetry.ts`) that mirrors the body through an
   SSE-comment parser. The caller's stream is unchanged, byte for byte.
2. The inner request runs on the real `openai-completions` api with the
   original model, so nothing about the wire format changes.
3. When the terminal event arrives, the parsed `response-cost` **overwrites**
   `message.usage.cost.total` — never adds, since the session ledger sums
   `usage.cost` verbatim and nothing recomputes it afterwards.

Model rows still carry zero catalog prices; the session ledger learns the real
number from the message. `/omniroute-usage` shows the last 10 responses (cost,
tokens, tok/s, TTFT, cache hit) from a bounded in-memory log, because omp has no
per-message diagnostics field to attach them to.

Cost is only as good as the gateway report: an endpoint that streams without the
comment block keeps the modeled (zero) price, and non-streaming paths are
unaffected.

## Development

```bash
pnpm run typecheck          # tsc --noEmit
pnpm run test               # node --test — 36 unit tests, no harness loaded
pnpm run test:integration   # bun — real pi-ai dispatch against a fake gateway
```

`src/telemetry/pi-ai.ts` is the only module that imports the harness at
runtime, so the unit suite never touches `@oh-my-pi/pi-ai` (whose entrypoint is
TypeScript source and only loads under Bun).

Layout: `src/provider.ts` (provider identity, model mapping, discovery),
`src/config.ts` (agent-dir config store), `src/login.ts` (`/login-omniroute`
key prompt + gateway check), `src/tools/*` (HTTP helpers, the two tools, live
search catalog), `src/telemetry/*` (cost telemetry),
`src/index.ts` (extension entry, command handlers).
