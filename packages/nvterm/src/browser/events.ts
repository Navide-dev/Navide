export interface IDisposable {
  dispose(): void
}

export type Event<T> = (listener: (value: T) => void) => IDisposable

export class Emitter<T> {
  private listeners: ((value: T) => void)[] = []

  readonly event: Event<T> = (listener) => {
    this.listeners.push(listener)
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener) } }
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value)
  }

  clear(): void {
    this.listeners = []
  }
}

/** A 1-based buffer position: x is the column, y the buffer line (scrollback included). */
export interface BufferPoint {
  x: number
  y: number
}

export interface Link {
  /** Inclusive range, 1-based. */
  range: { start: BufferPoint; end: BufferPoint }
  text: string
  activate(event: MouseEvent, text: string): void
  hover?(event: MouseEvent, text: string): void
  leave?(event: MouseEvent, text: string): void
}

export interface LinkProvider {
  /** Links on 1-based buffer line `bufferLineNumber`; call back with undefined for none. */
  provideLinks(bufferLineNumber: number, callback: (links: Link[] | undefined) => void): void
}
