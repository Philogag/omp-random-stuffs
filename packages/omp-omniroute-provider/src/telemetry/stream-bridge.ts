// The telemetry stream bridge, expressed against minimal structural types.
//
// omp dispatches a provider's `streamSimple` through a *custom api* registry, so
// taking over a provider's stream means re-entering the built-in dispatch with
// a model whose `api` is the real wire format. Both halves of that dance
// (create-stream / dispatch) are injected here, which keeps this module free of
// harness imports and testable with fakes.

import { applyTelemetryToUsage, telemetryLog, type TelemetryLog, type UsageLike } from "./cost.ts";
import { createTelemetrySink, withOmnirouteFetch, type OmnirouteTelemetry } from "./omniroute-telemetry.ts";

/** The wire format the request actually uses; custom apis cannot reuse the name. */
export const BUILTIN_OPENAI_API = "openai-completions";

export interface DoneEventLike {
  type: string;
  message?: { usage?: UsageLike };
}

export interface EventStreamLike {
  push(event: never): void;
  end(message?: never): void;
  fail?(error: unknown): void;
}

export interface StreamBridgeDeps {
  /** Terminal-event stream with `push`/`end`/`fail` and async iteration. */
  createStream: () => EventStreamLike;
  /** The harness' own `streamSimple`, used for the inner (real) request. */
  dispatch: (model: unknown, context: unknown, options: unknown) => EventStreamLike & AsyncIterable<DoneEventLike>;
  log?: TelemetryLog;
}

export interface StreamSimpleArgs {
  model: unknown;
  context: unknown;
  options?: unknown;
}

/** Options bag shape the bridge reads: just the injectable fetch. */
export interface StreamOptionsLike {
  fetch?: typeof fetch;
}

/**
 * Wraps the built-in dispatch so each response's OmniRoute telemetry lands on
 * the terminal message before consumers see it.
 *
 * Cost is *overwritten*, never added: the session ledger sums `usage.cost`
 * verbatim (nothing recomputes it), so a modeled total plus a gateway total
 * would double-bill the turn.
 */
export function buildTelemetryStreamSimple(deps: StreamBridgeDeps) {
  const log = deps.log ?? telemetryLog;

  return (model: unknown, context: unknown, options?: unknown): EventStreamLike => {
    const sink = createTelemetrySink();
    const out = deps.createStream();
    const optionsRecord = (options ?? {}) as StreamOptionsLike & Record<string, unknown>;
    const fetchImpl = optionsRecord.fetch ?? globalThis.fetch;

    // Same model, real wire api: the custom api name is only a dispatch hook.
    const innerModel = { ...(model as object), api: BUILTIN_OPENAI_API };
    const innerOptions = { ...optionsRecord, fetch: withOmnirouteFetch(fetchImpl, sink) };

    void (async () => {
      try {
        const inner = deps.dispatch(innerModel, context, innerOptions);
        for await (const event of inner) {
          if (event.type === "done") {
            // The terminal event can arrive a beat before the body drains.
            await sink.settle();
            const telemetry: OmnirouteTelemetry | undefined = sink.latest();
            log.record(telemetry);
            const usage = event.message?.usage;
            if (usage) applyTelemetryToUsage(usage, telemetry);
          }
          out.push(event as never);
        }
        out.end();
      } catch (err) {
        // Surface dispatch failures the way a normal provider stream would.
        if (out.fail) out.fail(err);
        out.end();
      }
    })();

    return out;
  };
}
