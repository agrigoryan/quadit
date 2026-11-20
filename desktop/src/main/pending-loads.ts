// Loads that wait for a gate, one per key, the newest asked winning. A
// server's window loads an address only once its server can be reached
// (server-windows.ts: the server on this computer must be running); a link
// or a sign-in that asks for another address while it waits replaces the
// one waiting, so the restored start page never lands over it.

export class PendingLoads<Key, Load, Gate> {
  /** The newest load asked for each key whose gate is not open yet. */
  private newest = new Map<Key, Load>();

  /**
   * `gate` is asked once per wait and says, when it resolves, whether and
   * how the load may go; `arrive` then gets the newest load asked for the key.
   */
  constructor(
    private gate: (key: Key) => Promise<Gate>,
    private arrive: (key: Key, load: Load, gate: Gate) => void,
  ) {}

  /** Asks for `load` once the gate opens; a load already waiting for `key` is replaced, under the same wait. */
  ask(key: Key, load: Load) {
    const already = this.newest.has(key);
    this.newest.set(key, load);
    if (already) return;
    void this.gate(key).then((opened) => {
      const latest = this.newest.get(key);
      if (latest === undefined) return;
      this.newest.delete(key);
      this.arrive(key, latest, opened);
    });
  }

  /** Whether a load waits for `key`'s gate. */
  waiting(key: Key): boolean {
    return this.newest.has(key);
  }

  /** Drops what waits for `key` (its window went). */
  forget(key: Key) {
    this.newest.delete(key);
  }
}
