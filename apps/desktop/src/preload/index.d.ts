import type { Bridge } from '../shared/rpc'

declare global {
  interface Window {
    amethyst: Bridge
  }
}
