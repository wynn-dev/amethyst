/** Test helper: a scripted `fetch` that records every call. */

export interface RecordedCall {
  url: URL
  method: string
  headers: Record<string, string>
  body: unknown
}

export type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | Error

export type Handler = (call: RecordedCall) => Reply | Promise<Reply>

export interface MockFetch {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  calls: RecordedCall[]
}

export function json(value: unknown, headers: Record<string, string> = {}, status = 200): Reply {
  return { status, json: value, headers }
}

/** Replies with `handler(call)`; an `Error` reply rejects like a network failure. */
export function mockFetch(handler: Handler): MockFetch {
  const calls: RecordedCall[] = []
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
    const call: RecordedCall = {
      url: new URL(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    init.signal?.throwIfAborted()
    const reply = await handler(call)
    if (reply instanceof Error) throw reply
    const text = reply.text ?? JSON.stringify(reply.json ?? null)
    return new Response(text, { status: reply.status ?? 200, headers: reply.headers })
  }
  return { fetch, calls }
}

/** Parses a JSON-encoded query parameter. */
export function jsonParam(url: URL, name: string): unknown {
  const v = url.searchParams.get(name)
  return v === null ? undefined : JSON.parse(v)
}
