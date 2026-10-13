declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component

  export interface AgentOverviewRow {
    paneId: string
    name: string
    vendor: string
    status: 'running' | 'idle' | 'awaiting' | 'starting' | 'stopped' | 'exited' | 'error' | 'waiting' | 'disconnected'
    foreignWorkspace: string
  }

  export interface OrphanSession {
    session_id: string
    preview: string[]
    size_bytes: number
    mtime: number
    resumable: boolean
    name: string
  }

  export interface TabItem {
    key: string
    label: string
    count: number
    live: number
    type: 'stage' | 'manual'
    status: string
  }
}
