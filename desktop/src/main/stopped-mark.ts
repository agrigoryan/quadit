// The server on this computer, stopped on purpose (desktop contract §11,
// amendment): with the app quit, the quadit command starts it in the
// background when a request finds its server not running, unless the
// person stopped that server from the app's menu. The sign between them is
// an empty file, server-stopped, in the folder of the quadit logins (where
// `quadit login --path` points, the folder Connect writes logins to): made
// when the person stops the server, taken away whenever the app starts it.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file's name, as the quadit command looks for it. */
const STOPPED_FILE = "server-stopped";

export class StoppedMark {
  private known: string | null = null;

  /**
   * `folder` gives the folder of the quadit logins, null where it cannot be
   * known (no quadit to ask yet): then the mark is neither made nor read,
   * and the folder is asked again next time.
   */
  constructor(private folder: () => Promise<string | null>) {}

  /** The person stopped the server: the command starts nothing for it. */
  async set() {
    const file = await this.file();
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }

  /** The app starts the server: the command may start the app again. */
  async clear() {
    const file = await this.file();
    if (file) rmSync(file, { force: true });
  }

  /** Whether the person stopped the server on purpose, and has not started it since. */
  async isSet(): Promise<boolean> {
    const file = await this.file();
    return !!file && existsSync(file);
  }

  private async file(): Promise<string | null> {
    this.known ??= await this.folder().catch(() => null);
    return this.known && join(this.known, STOPPED_FILE);
  }
}
