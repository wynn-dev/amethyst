/**
 * A tiny `fetch` stand-in for offline tests. Routes are keyed by `METHOD url` (query string
 * ignored). A route is a handler or a list of handlers used in order (the last one repeats).
 */

export interface RecordedCall {
  method: string
  url: string
  headers: Headers
  body: RequestInit['body']
  /** Request body decoded as text (string bodies only). */
  text?: string
}

export type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
export type Handler = Reply | ((call: RecordedCall) => Reply | Promise<Reply>)

export interface FakeFetch {
  fetch: typeof fetch
  calls: RecordedCall[]
  /** Calls whose URL (without query) equals `url`. */
  callsTo(url: string, method?: string): RecordedCall[]
  /** Replace or add a route. */
  route(key: string, handler: Handler | Handler[]): void
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, json: value, headers }
}

export function createFakeFetch(routes: Record<string, Handler | Handler[]> = {}): FakeFetch {
  const table = new Map<string, { handlers: Handler[]; index: number }>()
  const route = (key: string, handler: Handler | Handler[]) => table.set(key, { handlers: Array.isArray(handler) ? handler : [handler], index: 0 })
  for (const [k, v] of Object.entries(routes)) route(k, v)
  const calls: RecordedCall[] = []

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const bare = `${url.origin}${url.pathname}`
    const call: RecordedCall = { method, url: url.href, headers: new Headers(init.headers), body: init.body }
    if (typeof init.body === 'string') call.text = init.body
    calls.push(call)
    init.signal?.throwIfAborted()
    const entry = table.get(`${method} ${bare}`)
    if (!entry) return new Response(`no route for ${method} ${bare}`, { status: 599 })
    const handler = entry.handlers[Math.min(entry.index++, entry.handlers.length - 1)]!
    const reply = typeof handler === 'function' ? await handler(call) : handler
    init.signal?.throwIfAborted()
    const headers = new Headers(reply.headers)
    let body: string | null = reply.text ?? null
    if (reply.json !== undefined) {
      body = JSON.stringify(reply.json)
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    }
    return new Response(body, { status: reply.status ?? 200, headers })
  }

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    callsTo: (url, method) => calls.filter((c) => c.url.split('?')[0] === url && (!method || c.method === method)),
    route,
  }
}
