// OmniRoute cost telemetry: SSE-comment parsing + byte-transparent fetch wrapper.
//
// OmniRoute appends its per-response accounting as SSE comment lines
// (`: x-omniroute-response-cost=0.0123`) at the end of a streaming chat
// completion body, right before `data: [DONE]`. The OpenAI wire parser drops
// comment lines, so headers/usage never carry them — the only way to see the
// numbers is to tap the byte stream on its way through.
//
// Everything here is pure TypeScript with no harness imports, so it is
// unit-testable outside a running omp.

export interface OmnirouteTelemetry {
  responseCost?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensPerSecond?: number;
  ttftMs?: number;
  latencyMs?: number;
  model?: string;
  provider?: string;
  cacheHit?: boolean;
}

/** `: x-omniroute-<key>=<value>` — everything else is not ours. */
const TELEMETRY_LINE_RE = /^: x-omniroute-([a-z-]+)=(.*)$/;

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function finiteNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Parses one SSE comment line. Returns `null` when the line is not OmniRoute
 * telemetry at all, `{}` when it is a recognized key with an unusable value —
 * the distinction keeps malformed values from being reported as knowledge.
 */
export function parseOmnirouteTelemetryLine(line: string): Partial<OmnirouteTelemetry> | null {
  const match = TELEMETRY_LINE_RE.exec(line);
  if (!match) return null;
  const key = match[1] ?? "";
  const raw = match[2] ?? "";
  if (raw === "") return {};
  switch (key) {
    case "response-cost": {
      const value = finiteNumber(raw);
      return value === undefined ? {} : { responseCost: value };
    }
    case "tokens-in": {
      const value = finiteNumber(raw);
      return value === undefined ? {} : { tokensIn: value };
    }
    case "tokens-out": {
      const value = finiteNumber(raw);
      return value === undefined ? {} : { tokensOut: value };
    }
    case "latency-ms": {
      const value = finiteNumber(raw);
      return value === undefined ? {} : { latencyMs: value };
    }
    case "tokens-per-second": {
      const value = positiveNumber(raw);
      return value === undefined ? {} : { tokensPerSecond: value };
    }
    case "ttft-ms": {
      const value = positiveNumber(raw);
      return value === undefined ? {} : { ttftMs: value };
    }
    case "model":
      return { model: raw };
    case "provider":
      return { provider: raw };
    case "cache-hit":
      return { cacheHit: raw === "true" };
    default:
      // Unknown `x-omniroute-*` key: a future gateway field, not our data.
      return null;
  }
}

/** Folds every telemetry line in a fully decoded body into one record. */
export function extractOmnirouteTelemetry(text: string): OmnirouteTelemetry | undefined {
  let merged: OmnirouteTelemetry | undefined;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseOmnirouteTelemetryLine(line);
    if (parsed) merged = { ...(merged ?? {}), ...parsed };
  }
  return merged;
}

export interface TelemetrySink {
  /** Latest merged record; `undefined` until a line parses. */
  readonly latest: () => OmnirouteTelemetry | undefined;
  /** Roughly "the body is done draining" (or the timeout elapsed). */
  readonly settle: (timeoutMs?: number) => Promise<void>;
  readonly update: (telemetry: OmnirouteTelemetry) => void;
  readonly markDrained: () => void;
}

const DRAIN_GRACE_MS = 300;

/**
 * One sink per request. The terminal event can be observed a hair before the
 * body finishes draining, so consumers await {@link TelemetrySink.settle}
 * rather than reading `latest()` at the wrong instant.
 */
export function createTelemetrySink(): TelemetrySink {
  let merged: OmnirouteTelemetry | undefined;
  let drained = false;
  let onDrain: (() => void) | undefined;
  const drain = new Promise<void>((resolve) => {
    onDrain = () => {
      drained = true;
      resolve();
    };
  });

  return {
    latest: () => merged,
    update(telemetry) {
      merged = { ...(merged ?? {}), ...telemetry };
    },
    markDrained() {
      if (!drained) onDrain?.();
    },
    async settle(timeoutMs = DRAIN_GRACE_MS) {
      if (drained) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        drain,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          // Node/Bun: keep the timer from pinning the event loop.
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Byte-transparent TransformStream that also parses telemetry lines. */
export function createTelemetryTransformStream(sink: TelemetrySink): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (line: string): void => {
    const parsed = parseOmnirouteTelemetryLine(line.replace(/\r$/, ""));
    // Report eagerly: the telemetry block precedes `data: [DONE]`, so a consumer
    // that stops reading at the terminal event still sees the numbers.
    if (parsed) sink.update(parsed);
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // pass bytes through untouched
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    },
    flush() {
      if (buffer.length > 0) consume(buffer);
      buffer = "";
      sink.markDrained();
    },
  });
}

type FetchLike = typeof fetch;

/**
 * Wraps a fetch implementation so response bodies are mirrored through the
 * telemetry parser. Byte-for-byte transparent: the caller's response stream is
 * the only thing it reads, and every failure here is swallowed so telemetry can
 * never break a completion.
 */
export function withOmnirouteFetch(fetchImpl: FetchLike, sink: TelemetrySink): FetchLike {
  const wrapped: FetchLike = async (input, init) => {
    const response = await fetchImpl(input as never, init as never);
    if (!response.ok || !response.body) return response;

    const transform = createTelemetryTransformStream(sink);
    // `pipeTo` drives the parser as a side effect; the consumer reads `readable`.
    void response.body.pipeTo(transform.writable).catch(() => {
      // Aborted/truncated bodies are expected on cancel — still release waiters.
    });
    return new Response(transform.readable, response);
  };
  return wrapped as FetchLike;
}
