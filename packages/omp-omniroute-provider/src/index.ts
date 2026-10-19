// omp extension entry for the OmniRoute provider.
//
// Ported from the pi build (`@philogag/pi-provider-omniroute`) with no pi
// compatibility kept:
//   - provider registration is `registerProvider(id, ProviderConfig)` — the pi
//     `Provider` object with `getModels`/`refreshModels`/publish+store plumbing
//     is gone, replaced by the native `fetchDynamicModels` factory.
//   - settings edits go through omp's built-in `ui.select` / `ui.input`
//     dialogs instead of a custom TUI overlay component.
//   - streaming needs no `stream`/`streamSimple` wrappers: the pi build used
//     them only to inject telemetry, which omp cannot surface (see NOTES).

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  readConfig,
  resolveBaseUrl,
  resolveConfigPath,
  setAgentDirResolver,
  setBaseUrl,
  setFetchProvider,
  setSearchProvider,
  validateAndNormalizeBaseUrl,
} from "./config.ts";
import { createProviderConfig, PROVIDER_ID, PROVIDER_NAME } from "./provider.ts";
import { createFetchTool, FETCH_PROVIDERS, normalizeFetchProvider } from "./tools/web-fetch.ts";
import { createSearchTool, isValidProvider, SEARCH_PROVIDERS } from "./tools/search.ts";

const AUTO_LABEL = "Auto — let OmniRoute choose";
const BACK_LABEL = "← Back";

export default function omnirouteExtension(pi: ExtensionAPI): void {
  // Profile-aware data dir (`~/.omp/profiles/<name>/agent` under `--profile`).
  setAgentDirResolver(() => pi.pi.getAgentDir());

  // Mutable module-level base URL: the getter below keeps the registered
  // provider and both tools reading the same live value.
  let baseUrl = resolveBaseUrl();
  const currentBaseUrl = () => baseUrl;

  let configSearchProvider: string | undefined = readConfig().search?.provider;
  let configFetchProvider: string | undefined = readConfig().fetch?.provider;

  pi.registerProvider(PROVIDER_ID, createProviderConfig(currentBaseUrl));

  const tools = [
    createSearchTool({ pi, getConfiguredProvider: () => configSearchProvider }),
    createFetchTool({ pi, getConfiguredProvider: () => configFetchProvider }),
  ];
  for (const tool of tools) {
    try {
      pi.registerTool(tool);
    } catch (err) {
      pi.logger.warn(`[omniroute] failed to register tool ${tool.name}`, { err: String(err) });
    }
  }

  pi.on("session_start", async () => {
    const config = readConfig();
    configSearchProvider = config.search?.provider;
    configFetchProvider = normalizeFetchProvider(config.fetch?.provider);
    // Re-read after a profile switch or an external file edit.
    baseUrl = resolveBaseUrl();
  });

  pi.registerCommand("omniroute-settings", {
    description: "OmniRoute settings (search provider, web-fetch provider, base URL)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(`OmniRoute base URL: ${baseUrl}. Edit ${resolveConfigPath()} to change it here.`, "info");
        return;
      }
      await runSettingsMenu(ctx, {
        getBaseUrl: currentBaseUrl,
        getSearchProvider: () => configSearchProvider,
        getFetchProvider: () => configFetchProvider,
        setSearchProvider: (provider) => {
          configSearchProvider = provider;
          setSearchProvider(provider);
        },
        setFetchProvider: (provider) => {
          configFetchProvider = provider;
          setFetchProvider(provider);
        },
        setBaseUrl: async (value) => {
          setBaseUrl(value);
          baseUrl = resolveBaseUrl();
          await refreshModels(ctx);
        },
      });
    },
  });

  async function refreshModels(ctx: ExtensionContext): Promise<void> {
    try {
      await ctx.modelRegistry.refreshProvider(PROVIDER_ID, "online");
    } catch (err) {
      pi.logger.warn("[omniroute] model refresh after base-URL change failed", { err: String(err) });
      ctx.ui.notify("Base URL saved — models refresh on the next session.", "warning");
    }
  }
}

export interface SettingsMenuDeps {
  getBaseUrl: () => string;
  getSearchProvider: () => string | undefined;
  getFetchProvider: () => string | undefined;
  setSearchProvider: (provider: string | undefined) => void;
  setFetchProvider: (provider: string | undefined) => void;
  setBaseUrl: (value: string | undefined) => Promise<void>;
}

/** Two-level menu: root → provider list / base-URL prompt. Exported for tests. */
export async function runSettingsMenu(
  ctx: ExtensionContext,
  deps: SettingsMenuDeps,
  maxSteps = 20,
): Promise<void> {
  const ui = ctx.ui;
  for (let step = 0; step < maxSteps; step++) {
    const target = await ui.select(`${PROVIDER_NAME} settings`, [
      {
        label: "Web search provider",
        description: deps.getSearchProvider() ?? "auto (OmniRoute decides)",
      },
      {
        label: "Web fetch provider",
        description: deps.getFetchProvider() ?? "auto (OmniRoute decides)",
      },
      { label: "Base URL", description: deps.getBaseUrl() },
    ]);
    if (target === undefined) return;

    if (target === "Base URL") {
      const entered = await ui.input("OmniRoute base URL", deps.getBaseUrl());
      if (entered === undefined) continue;
      let normalized: string | undefined;
      try {
        normalized = validateAndNormalizeBaseUrl(entered);
      } catch (err) {
        ui.notify(err instanceof Error ? err.message : String(err), "error");
        continue;
      }
      await deps.setBaseUrl(normalized);
      ui.notify(`OmniRoute base URL set to ${normalized ?? "the default"}`, "info");
      continue;
    }

    if (target === "Web search provider") {
      const choice = await ui.select(
        "Web search provider",
        providerOptions(SEARCH_PROVIDERS, deps.getSearchProvider(), isValidProvider),
      );
      if (choice === undefined || choice === BACK_LABEL) continue;
      deps.setSearchProvider(choice === AUTO_LABEL ? undefined : choice);
      ui.notify(`Web search provider: ${choice}`, "info");
      continue;
    }

    if (target === "Web fetch provider") {
      const choice = await ui.select(
        "Web fetch provider",
        providerOptions(FETCH_PROVIDERS, deps.getFetchProvider(), (v): v is string =>
          typeof v === "string" && (FETCH_PROVIDERS as readonly string[]).includes(v),
        ),
      );
      if (choice === undefined || choice === BACK_LABEL) continue;
      deps.setFetchProvider(choice === AUTO_LABEL ? undefined : choice);
      ui.notify(`Web fetch provider: ${choice}`, "info");
    }
  }
}

function providerOptions(
  providers: readonly string[],
  current: string | undefined,
  isValid: (value: string | undefined) => value is string,
): Array<{ label: string; description?: string }> {
  const options: Array<{ label: string; description?: string }> = [
    { label: AUTO_LABEL, description: "Omit the provider and let OmniRoute route by config" },
  ];
  for (const provider of providers) {
    options.push({
      label: provider,
      description: isValid(current) && current === provider ? "current default" : undefined,
    });
  }
  options.push({ label: BACK_LABEL });
  return options;
}
