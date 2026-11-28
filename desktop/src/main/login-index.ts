// The private index the quadit command keeps beside its logins, index.json
// (multi-workspace design §3.2): for each tool's base login (the file its
// QUADIT_CONFIG names, or the computer's default one), the login file of
// each workspace it works in, and the folders tied to a workspace. The
// quadit command alone writes it (quadit login, logout, use); the app only
// reads it, to know which file a connection's login is and which folders
// work in a workspace. A tool with no entry has the one login of its base
// file, as before the index.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { realPath } from "@/main/config-edits";

/** One connection the index lists: a tool's login in one workspace of one server. */
export interface IndexedLogin {
  /** The tool's base login, real path. */
  tool: string;
  /** This connection's own login file, real path. */
  login: string;
  server: string;
  workspaceId: string;
  agentId: string;
  /** The agent's handle, without "@". */
  agent: string;
}

/** A folder tied to a workspace, and to one of its projects when the tie names one. */
export interface Tie {
  /** As the index has it, real path. */
  folder: string;
  workspaceId: string;
  project: string | null;
}

export interface LoginIndex {
  connections: IndexedLogin[];
  folders: Tie[];
}

/**
 * The index in the folder of the logins `folder`: none there is an empty
 * one. One that cannot be read, or is not the index's form, throws: what
 * it says decides which file a Disconnect takes away.
 */
export function readIndex(folder: string): LoginIndex {
  const file = join(folder, "index.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { connections: [], folders: [] };
    throw new Error(`${file} cannot be read: ${(err as Error).message}`, { cause: err });
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`${file} is not the quadit command's index`);
  const { connections, folders } = raw as { connections?: unknown; folders?: unknown };
  return {
    connections: listOf(connections).flatMap((c) => {
      const { tool, login, server, workspace_id, agent_id, agent } = c;
      if (![tool, login, server, workspace_id, agent_id].every((v) => typeof v === "string" && v !== "")) return [];
      return [
        {
          tool: realPath(tool as string),
          login: realPath(login as string),
          server: server as string,
          workspaceId: workspace_id as string,
          agentId: agent_id as string,
          agent: typeof agent === "string" ? agent.replace(/^@/, "") : "",
        },
      ];
    }),
    folders: listOf(folders).flatMap((f) => {
      const { folder, workspace_id, project } = f;
      if (typeof folder !== "string" || folder === "" || typeof workspace_id !== "string") return [];
      return [{ folder, workspaceId: workspace_id, project: typeof project === "string" && project ? project : null }];
    }),
  };
}

/** The connections of the tool whose base login is `base`, as the index lists them. */
export function loginsOf(index: LoginIndex, base: string): IndexedLogin[] {
  const tool = realPath(base);
  return index.connections.filter((c) => c.tool === tool);
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
}
