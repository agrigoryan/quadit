// The servers a person added, kept in one JSON file in the app's data
// folder. A server is known by its origin; its id is made once when it is
// added and never changes, because its window's saved place and its
// signed-in session (the partition "persist:server-<id>") hang off it.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Server {
  /** Made when the server is added; stable for its life in the app. */
  id: string;
  /** What the person calls it; the host name unless they gave one. */
  name: string;
  /** "https://host:port": the only address whose pages belong to this server. */
  origin: string;
  /** Whether its window was open when the app last stopped, so the next start opens it again. */
  open: boolean;
  /** The sign-in hand-off version the server last said it speaks (0 when it has none). */
  handoff: number;
  /** The Quadit version the server last said it runs ("" until it has answered). */
  version: string;
  /** The version and fit the person was last told about when the server did not fit the app ("" when it fit). */
  warned: string;
}

type Change = Partial<Pick<Server, "name" | "open" | "handoff" | "version" | "warned">>;

export class ServerStore {
  private servers: Server[];
  private listeners = new Set<() => void>();

  /** Reads `file`; a missing or unreadable file is an empty list, so a first start and a damaged file both start clean. */
  constructor(private file: string) {
    this.servers = readServers(file);
  }

  list(): readonly Server[] {
    return this.servers;
  }

  get(id: string): Server | undefined {
    return this.servers.find((server) => server.id === id);
  }

  byOrigin(origin: string): Server | undefined {
    return this.servers.find((server) => server.origin === origin);
  }

  /** Adds the server at `origin`. One already there with that origin is kept (its id and session) and renamed when a name is given. */
  add(origin: string, name: string, handoff: number): Server {
    const known = this.byOrigin(origin);
    const named = name.trim() || new URL(origin).host;
    if (known) {
      this.change(known.id, { handoff, ...(name.trim() ? { name: named } : {}) });
      return this.get(known.id) ?? known;
    }
    const server: Server = {
      id: randomBytes(6).toString("hex"),
      name: named,
      origin,
      open: false,
      handoff,
      version: "",
      warned: "",
    };
    this.servers = [...this.servers, server];
    this.save();
    return server;
  }

  /** Changes a server's fields; an unknown id is ignored (the server was removed meanwhile). */
  change(id: string, change: Change) {
    const before = this.get(id);
    if (!before) return;
    const after = { ...before, ...change };
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    this.servers = this.servers.map((server) => (server.id === id ? after : server));
    this.save();
  }

  remove(id: string) {
    if (!this.get(id)) return;
    this.servers = this.servers.filter((server) => server.id !== id);
    this.save();
  }

  /** Calls `listener` after every change; gives the function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private save() {
    // Written beside and renamed over, so a crash never leaves half a file.
    mkdirSync(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    writeFileSync(next, JSON.stringify({ servers: this.servers }, null, 2));
    renameSync(next, this.file);
    for (const listener of this.listeners) listener();
  }
}

function readServers(file: string): Server[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: Partial<Server>) =>
    typeof item.id === "string" && typeof item.origin === "string" && typeof item.name === "string"
      ? [
          {
            id: item.id,
            name: item.name,
            origin: item.origin,
            open: item.open === true,
            handoff: Number(item.handoff) || 0,
            version: typeof item.version === "string" ? item.version : "",
            warned: typeof item.warned === "string" ? item.warned : "",
          },
        ]
      : [],
  );
}
