// SSE serialization for the local-model chat stream (MBOX-284).
//
// Turns the normalized StreamEvent generator (streaming-client.ts) into a
// browser-facing text/event-stream. The frame contract the chat UI (MBOX-287)
// consumes:
//
//   event: token
//   data: {"delta":"Hi"}
//
//   event: done
//   data: {"model":"qwen3-4b-ctx4k","done_reason":"stop","prompt_eval_count":412,"eval_count":27}
//
//   event: error
//   data: {"code":"local_unavailable","detail":"...","runtime":"llama-cpp"}
//
// Each frame is `event: <type>\ndata: <json>\n\n`. The named `event:` lets the
// UI attach an EventSource listener per type. A terminal 'done' or 'error'
// frame always closes the stream; the UI distinguishes 'error' with
// code 'local_unavailable' (box down) from a clean 'done' with zero preceding
// 'token' frames (model legitimately produced nothing) — the AC's
// "graceful local-unavailable error distinct from a normal empty response".

import type { RuntimeKind, StreamEvent } from './types';

/** Serialize one normalized event to an SSE frame string. */
export function toSseFrame(event: StreamEvent): string {
  const { type, ...rest } = event;
  return `event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`;
}

/**
 * Wrap a StreamEvent async generator into a ReadableStream of SSE bytes ready
 * to hand to a Response. Encoding the relay this way (rather than buffering)
 * is what gives the browser true token-by-token delivery.
 */
export function sseStreamFromEvents(
  events: AsyncGenerator<StreamEvent, void, unknown>,
  runtime: RuntimeKind,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(toSseFrame(value)));
        // A terminal event ends the SSE stream — drain the generator and close
        // so the browser's EventSource sees a clean end rather than a hang.
        if (value.type === 'done' || value.type === 'error') {
          await events.return?.(undefined);
          controller.close();
        }
      } catch (err) {
        // Defensive: an unexpected throw inside the relay becomes a terminal
        // error frame rather than a dropped connection.
        controller.enqueue(
          encoder.encode(
            toSseFrame({
              type: 'error',
              code: 'upstream_malformed',
              detail: err instanceof Error ? err.message : String(err),
              runtime,
            }),
          ),
        );
        controller.close();
      }
    },
    async cancel() {
      // Browser disconnected — tear down the upstream relay.
      await events.return?.(undefined);
    },
  });
}

/** Standard headers for an SSE response. */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Disable proxy buffering (Caddy/nginx) so frames flush immediately.
  'x-accel-buffering': 'no',
};
