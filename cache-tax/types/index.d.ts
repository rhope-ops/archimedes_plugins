export type CacheInfo = {
  lastAt: number
  ttl: '5m' | '1h'
  tokens: number
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-tax': { info: Shaped<CacheInfo | null>; now: number }
  }
}
