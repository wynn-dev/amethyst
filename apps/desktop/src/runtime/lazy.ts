/**
 * Deferred service registration. `ServiceRegistry` dispatches only *own* methods, so a facade is
 * a plain object with one wrapper per method; `methods` must list every method of the interface
 * (checked at compile time), and each call waits for boot and builds the real implementation on
 * first use.
 */
type Methods<S> = { [K in keyof S]: S[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<R> : never }

export function deferred<S extends object>(methods: Record<keyof S, true>, get: () => Promise<S> | S): S {
  const out = {} as Record<string, unknown>
  for (const name of Object.keys(methods)) {
    out[name] = async (...args: unknown[]) => {
      const impl = (await get()) as Record<string, (...a: unknown[]) => Promise<unknown>>
      return impl[name]?.(...args)
    }
  }
  return out as unknown as Methods<S> as S
}

/** Memoise an async factory; a failed attempt is retried on the next call. */
export function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined
  return () => {
    p ??= factory().catch((e: unknown) => {
      p = undefined
      throw e
    })
    return p
  }
}
