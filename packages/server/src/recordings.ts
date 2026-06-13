/** Tracks in-flight recordings: name -> the buffer cursor at record_start. */
export class RecordingStore {
  readonly #active = new Map<string, number>();

  start(name: string, cursor: number): void {
    this.#active.set(name, cursor);
  }

  /** Returns the start cursor and clears the recording, or undefined if not recording. */
  stop(name: string): number | undefined {
    const cursor = this.#active.get(name);
    this.#active.delete(name);
    return cursor;
  }

  active(): string[] {
    return [...this.#active.keys()];
  }
}
