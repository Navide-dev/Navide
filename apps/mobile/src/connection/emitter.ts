import type { TransportEvent } from './transport.ts'

export class Emitter {
  private listeners = new Set<(event: TransportEvent) => void>()

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: TransportEvent): void {
    for (const l of this.listeners) l(event)
  }
}
