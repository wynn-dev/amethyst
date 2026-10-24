import { useEffect, useState } from 'react'
import { api } from './lib/rpc'

export function App() {
  const [version, setVersion] = useState<string>()

  useEffect(() => {
    api.app.getInfo().then((info) => setVersion(info.version))
  }, [])

  return (
    <div className="flex h-screen">
      <aside className="w-60 shrink-0 pt-12 [-webkit-app-region:drag]" />
      <main className="flex-1 bg-white/80 p-8 dark:bg-neutral-900/80">
        <h1 className="text-2xl font-semibold tracking-tight">Amethyst</h1>
        <p className="text-sm text-neutral-500">{version ? `v${version}` : '…'}</p>
      </main>
    </div>
  )
}
