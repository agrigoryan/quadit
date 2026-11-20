// The app's own settings: settings.json in its data folder, written whole
// on every change. The setup page shows most of them (setup-page.ts).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CaptureTarget } from "@/shared/pages-api";

export interface AppSettings {
  /** Setup was finished or skipped: it no longer opens at the start. */
  setupDone: boolean;
  /** Whether quick capture has its global key. */
  captureShortcut: boolean;
  /** Where quick capture last put something. */
  lastCapture: CaptureTarget | null;
  /**
   * The port of the server the app runs on this computer (local-server.ts),
   * chosen when it was first set up and never changed after: its address is
   * that server's identity. Null until then.
   */
  localPort: number | null;
}

export class Settings {
  private current: AppSettings;

  /** Reads `file`; a missing or unreadable one is the defaults, so a first start and a damaged file both start clean. */
  constructor(private file: string) {
    this.current = readSettings(file);
  }

  get(): AppSettings {
    return this.current;
  }

  change(change: Partial<AppSettings>) {
    this.current = { ...this.current, ...change };
    mkdirSync(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    writeFileSync(next, JSON.stringify(this.current, null, 2), { mode: 0o600 });
    renameSync(next, this.file);
  }
}

function readSettings(file: string): AppSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) raw = parsed as Record<string, unknown>;
  } catch {
    // None yet, or unreadable: the defaults.
  }
  const last = raw.lastCapture as Partial<CaptureTarget> | undefined;
  const lastCapture =
    last &&
    typeof last.serverId === "string" &&
    typeof last.workspaceId === "string" &&
    (typeof last.project === "string" || last.project === null) &&
    (last.what === "task" || last.what === "page")
      ? { serverId: last.serverId, workspaceId: last.workspaceId, project: last.project, what: last.what }
      : null;
  const localPort =
    typeof raw.localPort === "number" && Number.isInteger(raw.localPort) && raw.localPort > 0 && raw.localPort < 65536
      ? raw.localPort
      : null;
  return { setupDone: raw.setupDone === true, captureShortcut: raw.captureShortcut !== false, lastCapture, localPort };
}
