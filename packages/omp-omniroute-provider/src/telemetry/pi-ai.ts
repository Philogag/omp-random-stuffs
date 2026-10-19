// The only module that imports the harness at *runtime*.
//
// `@oh-my-pi/pi-ai` ships TypeScript sources and resolves through omp's own
// module loader (the `@oh-my-pi/pi-ai` root is remapped onto the host's copy),
// so this import is valid inside omp — which runs on Bun — and nowhere else.
// Plain-Node unit tests stay out of this file; they exercise `stream-bridge.ts`
// with fake streams instead.

import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

import { buildTelemetryStreamSimple } from "./stream-bridge.ts";

type OmnirouteStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * `ProviderConfig.streamSimple` for the `omniroute-openai-completions` api: the
 * built-in openai-completions request, with the response body mirrored through
 * OmniRoute's telemetry parser so the real cost lands on the message.
 */
/**
 * `ProviderConfig.streamSimple` for the `omniroute-openai-completions` api: the
 * built-in openai-completions request, with the response body mirrored through
 * OmniRoute's telemetry parser so the real cost lands on the message.
 *
 * The single cast is the harness boundary: `stream-bridge.ts` is written against
 * structural stream types so it stays Node-testable.
 */
export const omnirouteStreamSimple = buildTelemetryStreamSimple({
  createStream: () => createAssistantMessageEventStream(),
  dispatch: (model, context, options) =>
    streamSimple(model as Model<Api>, context as Context, options as SimpleStreamOptions | undefined),
}) as unknown as OmnirouteStreamSimple;
