export type Touched = {
  path: string
  state: 'read' | 'changed' | 'committed'
  isActive: boolean
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'file-tree': { files: Shaped<Touched[]> }
  }
}
