import type { ReactiveValue } from '@navide/plugin-ui/shared'

/** The shared settings store's backend: `ui.settings.*` over the Host socket. */
export interface SettingsPort {
  status: ReactiveValue<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>
  getAll(): Promise<Record<string, unknown> | null>
  setMany(updates: Record<string, unknown>): Promise<void>
  onChanged(callback: (payload: unknown) => void): () => void
}
