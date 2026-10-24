import type { Services } from '@shared/services'
import type { Events } from '@shared/events'

export class RemoteError extends Error {
  constructor(
    name: string,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = name
  }
}

function service<K extends keyof Services>(name: K): Services[K] {
  return new Proxy({} as Services[K], {
    get: (_, method) => {
      if (typeof method !== 'string') return undefined
      return async (...args: unknown[]) => {
        const result = await window.amethyst.invoke(name, method, args)
        if (!result.ok) throw new RemoteError(result.error.name, result.error.message, result.error.code)
        return result.value
      }
    },
  })
}

/** Typed proxy over every main-process service, e.g. `api.app.getInfo()`. */
export const api = new Proxy({} as Services, {
  get: (cache, name: string) => ((cache as unknown as Record<string, unknown>)[name] ??= service(name as keyof Services)),
})

type Listener<K extends keyof Events> = (payload: Events[K]) => void
const listeners = new Map<string, Set<Listener<never>>>()

// The bridge is absent outside Electron (component tests); events simply never arrive there.
window.amethyst?.on((event, payload) => {
  listeners.get(event)?.forEach((fn) => (fn as (p: unknown) => void)(payload))
})

export function subscribe<K extends keyof Events>(event: K, fn: Listener<K>): () => void {
  let set = listeners.get(event)
  if (!set) listeners.set(event, (set = new Set()))
  set.add(fn as Listener<never>)
  return () => set.delete(fn as Listener<never>)
}
