/**
 * A stand-in for api.anthropic.com: a `fetch` that records every request and answers with canned
 * JSON or a streamed (SSE) message — no test ever talks to the real API. Installed as the global
 * fetch (vi.stubGlobal), which the SDK picks up when a client is created.
 */

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body (null for GET). */
  readonly body: unknown;
}

export interface SseEvent {
  readonly event: string;
  readonly data: unknown;
}

export type Reply =
  | { readonly kind: 'sse'; readonly events: readonly SseEvent[]; readonly hang?: boolean }
  | { readonly kind: 'json'; readonly status: number; readonly body: unknown; readonly headers?: Readonly<Record<string, string>> }
  | { readonly kind: 'network' };

export type Responder = (request: RecordedRequest, index: number) => Reply;

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function sseText(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export interface FakeApi {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
}

export function fakeAnthropicApi(responder: Responder): FakeApi {
  const requests: RecordedRequest[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const raw = init?.body;
    const body = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw === undefined || raw === null ? null : '(non-string body)';
    const request: RecordedRequest = { url, method: init?.method ?? 'GET', headers, body };
    requests.push(request);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    const reply = responder(request, requests.length - 1);
    if (reply.kind === 'network') throw new TypeError('fetch failed');
    if (reply.kind === 'json') {
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', 'request-id': `req_test_${requests.length}`, ...reply.headers },
      });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of reply.events) controller.enqueue(encoder.encode(sseText(event)));
        if (!reply.hang) {
          controller.close();
          return;
        }
        // Keep the stream open until the request is aborted (a long answer being cancelled).
        const onAbort = (): void => controller.error(abortError());
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': `req_test_${requests.length}` } });
  };
  return { fetch: fakeFetch as typeof fetch, requests };
}

export interface MessageScript {
  readonly text?: string | readonly string[];
  readonly stopReason?: string;
  readonly stopDetails?: unknown;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly iterations?: readonly unknown[] | null;
  /** Extra content blocks to put before the text (e.g. a thinking or fallback block). */
  readonly leadingBlocks?: readonly unknown[];
}

/** The SSE events of one streamed message. */
export function messageEvents(script: MessageScript = {}): SseEvent[] {
  const texts = script.text === undefined ? ['## 요약\n테스트 보고서입니다.'] : typeof script.text === 'string' ? [script.text] : [...script.text];
  const events: SseEvent[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: script.model ?? 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: script.inputTokens ?? 1906, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    },
  ];
  let index = 0;
  for (const block of script.leadingBlocks ?? []) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index += 1;
  }
  for (const text of texts) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    // Split the text into a few deltas, like a real stream.
    const step = Math.max(1, Math.ceil(text.length / 3));
    for (let i = 0; i < text.length; i += step) {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(i, i + step) } } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index += 1;
  }
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: script.stopReason ?? 'end_turn', stop_sequence: null, stop_details: script.stopDetails ?? null },
      usage: { output_tokens: script.outputTokens ?? 1475, ...(script.iterations ? { iterations: script.iterations } : {}) },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

/** An API error response (the shape api.anthropic.com sends). */
export function apiError(status: number, type: string, message: string, headers: Readonly<Record<string, string>> = {}): Reply {
  return { kind: 'json', status, body: { type: 'error', error: { type, message } }, headers };
}
