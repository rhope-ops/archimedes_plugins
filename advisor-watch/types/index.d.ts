export type AdvisorCount = number

declare module 'claude-code' {
  interface PluginState {
    'advisor-watch': { session: AdvisorCount }
  }
}
