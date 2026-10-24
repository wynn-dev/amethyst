/**
 * The full RPC surface the renderer can call. Each domain adds its interface here.
 * Methods must be async and take/return structured-cloneable data only.
 */
export interface AppService {
  getInfo(): Promise<{ version: string; electron: string; chrome: string; node: string }>
}

export interface Services {
  app: AppService
}
