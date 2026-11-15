// What the tabs of one browser share, for tests: BroadcastChannel and
// navigator.locks, with the browser's rules. Neither delivers inside the
// call that caused it: a message or a lock arrives a moment later (in a
// microtask), so a test that lets pending work run sees it arrive.
//
// A test can also take part itself, as a tab that is not running the app:
// open a channel with `channel(name)`, ask for a lock with `locks.request`.

import { vi } from "vitest";

type Granted = (lock: { name: string; mode: "exclusive" }) => unknown;

interface LockOptions {
  steal?: boolean;
  signal?: AbortSignal;
}

interface LockRequest {
  name: string;
  granted: Granted;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

const abortError = (why: string) => new DOMException(why, "AbortError");

/** navigator.locks, exclusive locks only: one holder per name, the rest wait in line. */
class FakeLocks {
  private held = new Map<string, LockRequest>();
  private waiting: LockRequest[] = [];

  request(name: string, granted: Granted): Promise<unknown>;
  request(name: string, options: LockOptions, granted: Granted): Promise<unknown>;
  request(name: string, second: LockOptions | Granted, third?: Granted): Promise<unknown> {
    const options = typeof second === "function" ? {} : second;
    const granted = typeof second === "function" ? second : (third as Granted);
    return new Promise((resolve, reject) => {
      const request: LockRequest = { name, granted, resolve, reject };
      if (options.steal) {
        // The holder's request fails; whoever waits in line keeps waiting.
        this.held.get(name)?.reject(abortError("the lock was taken"));
        this.grant(request);
        return;
      }
      if (options.signal?.aborted) return reject(abortError("gave up waiting"));
      options.signal?.addEventListener("abort", () => {
        const at = this.waiting.indexOf(request);
        if (at < 0) return; // already granted: giving up waiting changes nothing
        this.waiting.splice(at, 1);
        reject(abortError("gave up waiting"));
      });
      this.waiting.push(request);
      this.next(name);
    });
  }

  query(): Promise<{ held: { name: string }[]; pending: { name: string }[] }> {
    return Promise.resolve({
      held: [...this.held.keys()].map((name) => ({ name })),
      pending: this.waiting.map(({ name }) => ({ name })),
    });
  }

  /** Whether anyone holds the lock of this name now. */
  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  private next(name: string) {
    if (this.held.has(name)) return;
    const at = this.waiting.findIndex((request) => request.name === name);
    if (at >= 0) this.grant(this.waiting.splice(at, 1)[0] as LockRequest);
  }

  private grant(request: LockRequest) {
    this.held.set(request.name, request);
    const release = () => {
      if (this.held.get(request.name) !== request) return; // taken from it meanwhile
      this.held.delete(request.name);
      this.next(request.name);
    };
    Promise.resolve()
      .then(() => request.granted({ name: request.name, mode: "exclusive" }))
      .then(
        (value) => {
          release();
          request.resolve(value);
        },
        (err: unknown) => {
          release();
          request.reject(err);
        },
      );
  }
}

/** One open BroadcastChannel. A message goes to every other open channel of the same name, copied. */
class FakeChannel {
  onmessage: ((e: MessageEvent) => void) | null = null;
  private closed = false;

  constructor(
    readonly name: string,
    private all: Set<FakeChannel>,
  ) {
    all.add(this);
  }

  postMessage(data: unknown) {
    if (this.closed) throw new DOMException("the channel is closed", "InvalidStateError");
    const copy = structuredClone(data);
    for (const other of this.all) {
      if (other === this || other.name !== this.name) continue;
      queueMicrotask(() => {
        if (!other.closed) other.onmessage?.({ data: structuredClone(copy) } as MessageEvent);
      });
    }
  }

  close() {
    this.closed = true;
    this.all.delete(this);
  }
}

export interface FakeTabs {
  locks: FakeLocks;
  /** Opens a channel as another tab would. */
  channel(name: string): FakeChannel;
  /** Takes BroadcastChannel away or gives it back, for modules loaded from now on: without it tabs cannot share. */
  setSharing(on: boolean): void;
}

/**
 * Puts a fake BroadcastChannel and navigator.locks in place of the real
 * ones until `vi.unstubAllGlobals()`. Everything that loads after this call
 * shares them, as the tabs of one browser do.
 */
export function fakeTabs(): FakeTabs {
  const locks = new FakeLocks();
  const channels = new Set<FakeChannel>();
  const Channel = class extends FakeChannel {
    constructor(name: string) {
      super(name, channels);
    }
  };
  vi.stubGlobal("navigator", { locks, onLine: true });
  vi.stubGlobal("BroadcastChannel", Channel);
  return {
    locks,
    channel: (name) => new Channel(name),
    setSharing: (on) => vi.stubGlobal("BroadcastChannel", on ? Channel : undefined),
  };
}
