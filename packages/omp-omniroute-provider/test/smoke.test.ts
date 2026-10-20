// Smoke tests for the omp port. Pure Node — no harness runtime is loaded, all
// `@oh-my-pi/pi-coding-agent` imports in src/ are type-only.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  OMNIROUTE_DEFAULT_BASE_URL,
  readConfig,
  resolveBaseUrl,
  setBaseUrl,
  setFetchProvider,
  setSearchProvider,
  validateAndNormalizeBaseUrl,
} from "../src/config.ts";
import {
  OMNIROUTE_API_KEY_ENV,
  PROVIDER_API,
  PROVIDER_ID,
  createProviderConfig,
  fetchOmnirouteModels,
  toProviderModel,
} from "../src/provider.ts";
import { probeGateway, runLoginWizard } from "../src/login.ts";
import { BUILTIN_OPENAI_API } from "../src/telemetry/stream-bridge.ts";
import { buildSearchBody, formatSearchResults, isValidProvider } from "../src/tools/search.ts";
import {
  SearchCatalogError,
  resolveSearchCatalog,
  searchProviderDescription,
} from "../src/tools/search-catalog.ts";
import { buildFetchBody, extractFetchContent, normalizeFetchProvider } from "../src/tools/web-fetch.ts";

function tempConfigDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-omniroute-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "omniroute.json");
}

test("provider identity", () => {
  assert.equal(PROVIDER_ID, "omniroute");
  // Custom api id: built-in names are reserved by `registerCustomApi`, and a
  // custom api is how `streamSimple` (and thus cost telemetry) gets attached.
  assert.equal(PROVIDER_API, "omniroute-openai-completions");
  assert.notEqual(PROVIDER_API, BUILTIN_OPENAI_API);
  assert.equal(OMNIROUTE_API_KEY_ENV, "OMNIROUTE_API_KEY");
});

test("provider config wires the injected streamSimple and the custom api", () => {
  const streamSimple = () => ({}) as never;
  const config = createProviderConfig(() => "http://gateway.local/v1", streamSimple);
  assert.equal(config.api, PROVIDER_API);
  assert.equal(config.streamSimple, streamSimple);
  assert.equal(config.baseUrl, "http://gateway.local/v1");

  // Without an injected bridge the provider still registers (tests, dry runs).
  const bare = createProviderConfig(() => "http://gateway.local/v1");
  assert.equal(bare.streamSimple, undefined);
  // Discovery models must use the same custom api id or dispatch misses them.
  assert.equal(toProviderModel({ id: "m" }).api, PROVIDER_API);
});

test("config: search/fetch/base-url round-trip", (t) => {
  const path = tempConfigDir(t);
  assert.deepEqual(readConfig(path), {});

  setSearchProvider("brave-search", path);
  setFetchProvider("jina-reader", path);
  setBaseUrl("http://gateway.local:9000/v1", path);

  const config = readConfig(path);
  assert.equal(config.search?.provider, "brave-search");
  assert.equal(config.fetch?.provider, "jina-reader");
  assert.equal(config.baseUrl, "http://gateway.local:9000/v1");
  assert.equal(resolveBaseUrl(path), "http://gateway.local:9000/v1");

  // undefined clears a key rather than writing a null
  setSearchProvider(undefined, path);
  setBaseUrl(undefined, path);
  const cleared = readConfig(path);
  assert.equal(cleared.search, undefined);
  assert.equal(cleared.baseUrl, undefined);
  assert.equal(cleared.fetch?.provider, "jina-reader");
});

test("config: base URL falls back to the default", (t) => {
  const path = tempConfigDir(t);
  const saved = process.env.OMNIROUTE_BASE_URL;
  delete process.env.OMNIROUTE_BASE_URL;
  t.after(() => {
    if (saved !== undefined) process.env.OMNIROUTE_BASE_URL = saved;
  });
  assert.equal(resolveBaseUrl(path), OMNIROUTE_DEFAULT_BASE_URL);
});

test("config: validateAndNormalizeBaseUrl", () => {
  assert.equal(validateAndNormalizeBaseUrl("  http://localhost:20128/v1  "), "http://localhost:20128/v1");
  assert.equal(validateAndNormalizeBaseUrl(""), OMNIROUTE_DEFAULT_BASE_URL);
  assert.throws(() => validateAndNormalizeBaseUrl("not a url"), /Invalid base URL/);
  assert.throws(() => validateAndNormalizeBaseUrl("ftp://example.com"), /http\(s\)/);
});

test("toProviderModel: capability mapping", () => {
  const full = toProviderModel({
    id: "gpt-5",
    name: "GPT-5",
    max_input_tokens: 400_000,
    max_output_tokens: 128_000,
    capabilities: { reasoning: true, thinking: true, vision: true },
  });
  assert.equal(full.id, "gpt-5");
  assert.equal(full.api, PROVIDER_API);
  assert.equal(full.reasoning, true);
  assert.deepEqual(full.thinking, { mode: "effort", efforts: ["minimal", "low", "medium", "high"] });
  assert.deepEqual(full.input, ["text", "image"]);
  assert.equal(full.contextWindow, 400_000);
  assert.equal(full.maxTokens, 128_000);

  const bare = toProviderModel({ id: "plain-model" });
  assert.equal(bare.name, "plain-model");
  assert.equal(bare.reasoning, false);
  assert.equal(bare.thinking, undefined);
  assert.deepEqual(bare.input, ["text"]);
  assert.equal(bare.contextWindow, 128_000);
  assert.equal(bare.maxTokens, 4_096);

  // context_length is the fallback when max_input_tokens is absent/zero
  const fallback = toProviderModel({ id: "m", context_length: 32_000, max_input_tokens: 0 });
  assert.equal(fallback.contextWindow, 32_000);
});

test("fetchOmnirouteModels: auth header + row filtering", async (t) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "" }, { notAnId: true }, { id: "b" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const models = await fetchOmnirouteModels("http://gateway/v1/", "secret-key");
  assert.deepEqual(
    models.map((m) => m.id),
    ["a", "b"],
  );
  assert.equal(calls[0]?.url, "http://gateway/v1/models");
  assert.equal(calls[0]?.headers.Authorization, "Bearer secret-key");

  await fetchOmnirouteModels("http://gateway/v1", undefined);
  assert.equal(calls[1]?.headers.Authorization, undefined);
});

test("fetchOmnirouteModels: non-2xx throws so omp keeps its cached catalog", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 503 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  await assert.rejects(() => fetchOmnirouteModels("http://gateway/v1", undefined), /OmniRoute \/models failed: 503/);
});

test("createProviderConfig: live base URL, env key rank, oauth login, discovery", async () => {
  let current = "http://first/v1";
  const config = createProviderConfig(() => current);

  assert.equal(config.baseUrl, "http://first/v1");
  assert.equal(config.api, PROVIDER_API);
  assert.equal(config.apiKey, OMNIROUTE_API_KEY_ENV);

  // the getter must follow later base-URL edits without re-registration
  current = "http://second/v1";
  assert.equal(config.baseUrl, "http://second/v1");

  const seen: Array<{ message: string; secret?: boolean }> = [];
  const auth: Array<{ url: string }> = [];
  const key = await config.oauth!.login({
    onAuth: (info: { url: string }) => {
      auth.push(info);
    },
    onPrompt: async (prompt: { message: string; secret?: boolean }) => {
      seen.push(prompt);
      return "  pasted-key  ";
    },
  } as never);
  assert.equal(key, "pasted-key");
  assert.equal(auth[0]?.url, "http://second");
  assert.equal(seen[0]?.secret, true);

  await assert.rejects(
    () =>
      config.oauth!.login({
        onAuth: () => {},
        onPrompt: async () => "   ",
      } as never),
    /No OmniRoute API key provided/,
  );

  assert.equal(typeof config.fetchDynamicModels, "function");
});

test("search: provider gating and body defaults", () => {
  assert.equal(isValidProvider("brave-search"), true);
  assert.equal(isValidProvider("auto"), false);
  assert.equal(isValidProvider("nope"), false);
  assert.equal(isValidProvider(undefined), false);

  assert.deepEqual(buildSearchBody({ query: "hello" }), {
    query: "hello",
    max_results: 5,
    search_type: "web",
    offset: 0,
    strict_filters: false,
  });

  const withExtras = buildSearchBody({
    query: "q",
    provider: "exa-search",
    max_results: 3,
    country: "US",
    time_range: "week",
    provider_options: { freshness: "pd" },
  });
  assert.equal(withExtras.provider, "exa-search");
  assert.equal(withExtras.max_results, 3);
  assert.equal(withExtras.country, "US");
  assert.equal(withExtras.time_range, "week");
  assert.deepEqual(withExtras.provider_options, { freshness: "pd" });
  assert.equal("synthesis" in withExtras, false);
});

test("search: formatSearchResults", () => {
  assert.equal(formatSearchResults({ results: [] }, "q"), "No results for query: q");
  assert.equal(
    formatSearchResults({ results: [{ title: "T", url: "https://x.test", snippet: "S" }] }, "q"),
    "1. T\n   URL: https://x.test\n   S",
  );
  // untitled results still get a label
  assert.equal(formatSearchResults({ results: [{ url: "https://y.test" }] }, "q"), "1. (untitled)\n   URL: https://y.test");
  // non-result payloads fall back to JSON
  assert.equal(formatSearchResults({ answer: "42" }, "q"), '{"answer":"42"}');
});

test("fetch: provider normalization and body defaults", () => {
  assert.equal(normalizeFetchProvider("firecrawl"), "firecrawl");
  assert.equal(normalizeFetchProvider("auto"), undefined);
  assert.equal(normalizeFetchProvider("bogus"), undefined);
  assert.equal(normalizeFetchProvider(undefined), undefined);

  assert.deepEqual(buildFetchBody({ url: "https://example.com" }), {
    url: "https://example.com",
    format: "markdown",
    depth: 0,
    include_metadata: false,
  });
  const full = buildFetchBody({
    url: "https://example.com",
    provider: "tinyfish",
    format: "html",
    depth: 2,
    wait_for_selector: "#main",
    include_metadata: true,
  });
  assert.deepEqual(full, {
    url: "https://example.com",
    format: "html",
    depth: 2,
    include_metadata: true,
    provider: "tinyfish",
    wait_for_selector: "#main",
  });
});

test("fetch: extractFetchContent", () => {
  assert.equal(extractFetchContent({ content: "# hi" }), "# hi");
  assert.equal(extractFetchContent({ content: { markdown: "md", text: "tx" } }), "md");
  assert.equal(extractFetchContent({ content: { text: "tx" } }), "tx");
  assert.equal(extractFetchContent({ markdown: "top-level" }), "top-level");
  assert.equal(extractFetchContent({ html: "<p>x</p>" }), "<p>x</p>");
  assert.equal(extractFetchContent({ other: 1 }), '{"other":1}');

  const long = extractFetchContent({ content: "x".repeat(40_100) });
  assert.ok(long.endsWith("[content truncated at 40000 chars]"));
  assert.equal(long.length, 40_000 + "\n\n[content truncated at 40000 chars]".length);
});

test("search catalog: parses the gateway list, keeps names out of labels", async (t) => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, "Bearer k");
    return new Response(
      JSON.stringify({
        data: [
          { id: "brave-search", name: "Brave", search_types: ["web", "news"] },
          { id: "tavily-search", name: "Tavily", search_types: ["web"] },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const catalog = await resolveSearchCatalog("http://gw/v1", "k");
  assert.equal(catalog.isFallback, false);
  assert.deepEqual(
    catalog.providers.map((p) => p.id),
    ["brave-search", "tavily-search"],
  );
  assert.equal(calls[0], "http://gw/v1/search");
  assert.equal(searchProviderDescription({ id: "brave-search", name: "Brave", search_types: ["web", "news"] }), "Brave · web, news");
  assert.equal(searchProviderDescription({ id: "x", name: "x", search_types: [] }), "search types: web");
});

test("search catalog: degrades to the static list", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const failures: unknown[] = [];
  for (const responder of [
    async () => new Response("nope", { status: 401 }),
    async () => new Response("not json", { status: 200 }),
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    async () => new Response(JSON.stringify({ data: [{ id: 1 }] }), { status: 200 }),
  ]) {
    globalThis.fetch = responder as unknown as typeof fetch;
    const catalog = await resolveSearchCatalog("http://gw/v1", undefined, {
      onError: (err) => failures.push(err),
    });
    assert.equal(catalog.isFallback, true);
    assert.equal(catalog.providers.length, 14);
    assert.equal(catalog.providers[0]?.id, "serper-search");
    assert.deepEqual(catalog.providers[0]?.search_types, ["web"]);
  }
  assert.equal(failures.length, 4);
  assert.ok(failures[0] instanceof SearchCatalogError);
});

// ---------------------------------------------------------------------------
// /login-omniroute wizard

interface FakeUi {
  readonly notifications: Array<{ message: string; type?: string }>;
  readonly selects: Array<readonly string[]>;
  readonly inputs: string[];
  readonly editors: Array<{ title: string; prefill: string }>;
}

function fakeCtx(answers: {
  input?: Array<string | undefined>;
  select?: Array<string | undefined>;
  editor?: Array<string | undefined>;
}): FakeUi & {
  ctx: never;
} {
  const notifications: Array<{ message: string; type?: string }> = [];
  const selects: Array<readonly string[]> = [];
  const inputs: string[] = [];
  const editors: Array<{ title: string; prefill: string }> = [];
  let inputIndex = 0;
  let selectIndex = 0;
  let editorIndex = 0;
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
      input: async (title: string) => {
        inputs.push(title);
        return answers.input?.[inputIndex++];
      },
      editor: async (title: string, prefill?: string) => {
        editors.push({ title, prefill: prefill ?? "" });
        // An omitted entry accepts the prefill; an explicit undefined cancels.
        if (answers.editor === undefined || editorIndex >= answers.editor.length) return prefill;
        return answers.editor[editorIndex++];
      },
      select: async (title: string, options: Array<{ label: string }>) => {
        selects.push([title, ...options.map((option) => option.label)]);
        return answers.select?.[selectIndex++];
      },
    },
  };
  return { notifications, selects, inputs, editors, ctx: ctx as never };
}

function wizardDeps(overrides: Partial<Parameters<typeof runLoginWizard>[1]> = {}) {
  const probes: Array<{ baseUrl: string; apiKey: string | undefined }> = [];
  const saves: string[] = [];
  const counts = { logins: 0, refreshes: 0 };
  let key: string | undefined;
  const base: Parameters<typeof runLoginWizard>[1] = {
    getBaseUrl: () => "http://localhost:20128/v1",
    normalizeBaseUrl: (value) => value.trim().replace(/\/+$/, ""),
    saveBaseUrl: (value) => {
      saves.push(value);
    },
    getApiKey: async () => key,
    probe: async (baseUrl, apiKey) => {
      probes.push({ baseUrl, apiKey });
      return { ok: true, status: 200, modelCount: 3 };
    },
    login: async () => {
      counts.logins++;
      key = "stored-key";
      return "omp auth store";
    },
    refreshModels: async () => {
      counts.refreshes++;
    },
    ...overrides,
  };
  return { deps: base, probes, saves, counts };
}

test("login: prefilled URL prompt, then the key prompt, verify, refresh", async () => {
  const { ctx, notifications, selects, inputs, editors } = fakeCtx({});
  const { deps, probes, saves, counts } = wizardDeps();

  const result = await runLoginWizard(ctx, deps);

  assert.deepEqual(result, { cancelled: false, baseUrl: "http://localhost:20128/v1", authenticated: true, modelCount: 3 });
  // URL prompt is prefilled with the live value; accepting it writes nothing.
  assert.deepEqual(editors, [{ title: "OmniRoute base URL", prefill: "http://localhost:20128/v1" }]);
  assert.deepEqual(saves, []);
  // No wizard steps: the key prompt belongs to omp's own login flow.
  assert.deepEqual(selects, []);
  assert.deepEqual(inputs, []);
  assert.deepEqual(counts, { logins: 1, refreshes: 1 });
  assert.deepEqual(probes, [{ baseUrl: "http://localhost:20128/v1", apiKey: "stored-key" }]);
  assert.ok(notifications.some((n) => n.message.includes("API key stored (omp auth store)")));
  assert.ok(notifications.some((n) => n.message.includes("OmniRoute is ready — 3 models available")));
});

test("login: an edited base URL is saved and probed instead of the old one", async () => {
  const { ctx, editors } = fakeCtx({ editor: ["https://gw.example.com/v1/"] });
  const { deps, probes, saves } = wizardDeps();

  const result = await runLoginWizard(ctx, deps);

  assert.equal(result.baseUrl, "https://gw.example.com/v1");
  assert.deepEqual(editors, [{ title: "OmniRoute base URL", prefill: "http://localhost:20128/v1" }]);
  assert.deepEqual(saves, ["https://gw.example.com/v1"]);
  assert.deepEqual(probes, [{ baseUrl: "https://gw.example.com/v1", apiKey: "stored-key" }]);
});

test("login: cancelling the base URL prompt aborts before the key prompt", async () => {
  const { ctx } = fakeCtx({ editor: [undefined] });
  const { deps, probes, saves, counts } = wizardDeps();

  const result = await runLoginWizard(ctx, deps);

  assert.deepEqual(result, { cancelled: true, baseUrl: "http://localhost:20128/v1", authenticated: false });
  assert.deepEqual(probes, []);
  assert.deepEqual(saves, []);
  assert.deepEqual(counts, { logins: 0, refreshes: 0 });
});

test("login: an invalid base URL re-prompts with the rejected text", async () => {
  const { ctx, notifications, editors } = fakeCtx({ editor: ["not a url", "https://gw.example.com/v1"] });
  const { deps, saves } = wizardDeps({
    normalizeBaseUrl: (value) => {
      if (!/^https?:\/\//.test(value)) throw new Error(`Invalid base URL: ${JSON.stringify(value)}`);
      return value;
    },
  });

  const result = await runLoginWizard(ctx, deps);

  assert.equal(result.baseUrl, "https://gw.example.com/v1");
  assert.equal(editors.length, 2);
  assert.equal(editors[1]?.prefill, "not a url");
  assert.deepEqual(saves, ["https://gw.example.com/v1"]);
  assert.ok(notifications.some((n) => n.type === "error" && n.message.includes("Invalid base URL")));
});

test("login: an existing key is replaced — the prompt always runs", async () => {
  const { ctx, notifications } = fakeCtx({});
  let key = "old-key";
  const { deps, probes, counts } = wizardDeps({
    getApiKey: async () => key,
    login: async () => {
      counts.logins++;
      key = "new-key";
      return "omp auth store";
    },
  });

  const result = await runLoginWizard(ctx, deps);

  assert.equal(result.authenticated, true);
  assert.deepEqual(counts, { logins: 1, refreshes: 1 });
  assert.deepEqual(probes, [{ baseUrl: "http://localhost:20128/v1", apiKey: "new-key" }]);
  assert.ok(notifications.some((n) => n.message.includes("API key stored (omp auth store)")));
});

test("login: abandoning the key prompt reports cancelled and probes nothing", async () => {
  const { ctx } = fakeCtx({});
  const { deps, probes, counts } = wizardDeps({ login: async () => undefined });

  const result = await runLoginWizard(ctx, deps);

  assert.deepEqual(result, { cancelled: true, baseUrl: "http://localhost:20128/v1", authenticated: false });
  assert.equal(probes.length, 0);
  assert.equal(counts.refreshes, 0);
});

test("login: a failed login flow stops without probing", async () => {
  const { ctx, notifications } = fakeCtx({});
  const { deps, probes } = wizardDeps({
    login: async () => {
      throw new Error("user aborted the browser flow");
    },
  });

  const result = await runLoginWizard(ctx, deps);

  assert.equal(result.cancelled, true);
  assert.equal(result.authenticated, false);
  assert.equal(probes.length, 0);
  assert.ok(notifications.some((n) => n.type === "error" && n.message.includes("user aborted the browser flow")));
});

test("login: a login that stores nothing is not treated as authenticated", async () => {
  const { ctx, notifications } = fakeCtx({});
  const { deps, probes } = wizardDeps({
    getApiKey: async () => undefined,
    login: async () => "env",
  });

  const result = await runLoginWizard(ctx, deps);

  assert.equal(result.authenticated, false);
  assert.equal(probes.length, 0);
  assert.ok(notifications.some((n) => n.type === "warning" && n.message.includes("without storing a key")));
});

test("login: a rejected key warns but keeps the stored credential", async () => {
  const { ctx, notifications } = fakeCtx({});
  const { deps, counts } = wizardDeps({
    probe: async () => ({ ok: false, status: 401, error: "HTTP 401" }),
  });

  const result = await runLoginWizard(ctx, deps);

  assert.equal(result.authenticated, true);
  assert.equal(counts.refreshes, 0);
  assert.ok(notifications.some((n) => n.type === "warning" && n.message.includes("the gateway rejected the key")));
});

test("probeGateway: status, model count, and transport errors stay distinct", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  assert.deepEqual(await probeGateway("http://gw/v1", undefined), { ok: false, status: 401, error: "HTTP 401" });

  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await probeGateway("http://gw/v1/", "k"), { ok: true, status: 200, modelCount: 2 });
  assert.equal(calls[0]?.url, "http://gw/v1/models");
  assert.equal(calls[0]?.headers.Authorization, "Bearer k");

  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await probeGateway("http://gw/v1", undefined), { ok: false, error: "ECONNREFUSED" });
});
