// The Connect page's window, and what it asks of Connect (connections.ts).

import { mkdirSync } from "node:fs";
import { type BrowserWindow, shell } from "electron";
import type { AppPages } from "@/main/app-pages";
import type { Connections } from "@/main/connections";
import type { ConnectChoice } from "@/shared/pages-api";

export class ConnectPage {
  private win: BrowserWindow | undefined;

  constructor(
    private pages: AppPages,
    private connections: Connections,
  ) {
    pages.answer({
      connectState: () => connections.state(),
      planConnect: (_sender, choice) => connections.planConnect(choiceOf(choice)),
      applyConnect: (_sender, planId) => connections.applyConnect(String(planId)),
      planDisconnect: (_sender, harness) => connections.planDisconnect(String(harness)),
      applyDisconnect: (_sender, planId) => connections.applyDisconnect(String(planId)),
      dropPlan: () => connections.dropPlans(),
      showBackups: async () => {
        mkdirSync(connections.backupsDir, { recursive: true });
        await shell.openPath(connections.backupsDir);
      },
    });
  }

  show() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = this.pages.window("connect.html", {
      name: "connect",
      width: 760,
      height: 780,
      minWidth: 560,
      minHeight: 480,
      title: "Connect Agents",
    });
    this.win.on("closed", () => {
      this.win = undefined;
      this.connections.dropPlans();
    });
  }
}

/** What the page sent as a choice, with its types checked; anything wrong reads as nothing chosen, which Connect refuses. */
function choiceOf(raw: unknown): ConnectChoice {
  const c = (raw ?? {}) as Record<string, unknown>;
  const agent = (c.agent ?? {}) as Record<string, unknown>;
  const create = (agent.create ?? {}) as Record<string, unknown>;
  return {
    harness: text(c.harness),
    serverId: text(c.serverId),
    workspaceId: text(c.workspaceId),
    methods: Array.isArray(c.methods) ? c.methods.filter((m) => m === "cli" || m === "mcp") : [],
    agent:
      c.agent === null
        ? null
        : typeof agent.id === "string"
          ? { id: agent.id }
          : { create: { name: text(create.name), handle: text(create.handle) } },
    allowUnattended: c.allowUnattended === true,
  };
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}
