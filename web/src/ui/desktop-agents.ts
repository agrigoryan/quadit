// What the desktop app says of the agents connected on its computer, and the
// way to its Connect window focused on one of them. Connecting, running and
// disconnecting change files on the person's computer, so only the app's own
// window does them: a page only opens it. A browser, or an app too old to
// answer, has none of this, and the page shows what a browser shows. Every
// use of the app's bridge for agents goes through here.

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useFollowFeed } from "@/data/live";
import { inWorkspace } from "@/data/query";
import { useSlug } from "@/data/selectors";

/** An agent of this window's workspace as the app on this computer connects it. */
export interface LocalAgent {
  /** The agent's user id. */
  agent: string;
  /** "claude", "codex", … */
  program: string;
  /** "Claude Code". */
  programName: string;
  /** This computer's name, as the runner reports it, or "". */
  computer: string;
  /** Run by Quadit is offered for it here. */
  canRun: boolean;
  /** Ids of the projects Quadit runs for it on this computer. */
  runs: string[];
}

/** What the app's Connect window opens on: connecting the agent, Run by Quadit for it, or its Disconnect. */
export type ConnectIntent = "connect" | "run" | "disconnect";

/**
 * The part of the app's bridge this module uses, declared here as the app
 * offers it; every member is missing in a browser or an older app.
 */
interface AgentsBridge {
  openConnect?(focus?: { agent?: string; intent?: ConnectIntent; program?: string }): void;
  localAgents?(): Promise<LocalAgent[]>;
}

const bridge = (): AgentsBridge | undefined => window.quaditDesktop;

/** Whether this page is in an app that can open its Connect window. */
export const canOpenConnect = () => !!bridge()?.openConnect;

/**
 * Opens the app's Connect window, on one agent and what to do for it when
 * given, at the program a LocalAgent the page shows names (of two that work
 * as that agent here, the one whose state the page showed).
 */
export function openConnect(agent?: string, intent?: ConnectIntent, program?: string) {
  bridge()?.openConnect?.(agent ? { agent, intent, ...(program ? { program } : {}) } : undefined);
}

/** How often the app is asked again while the page shows its answer. */
const REREAD_MS = 20_000;

/**
 * The agents the app on this computer connects, by agent id; null when the
 * page is not in an app that answers (a browser, an older app, or a call
 * that failed): the page then shows what a browser shows. Asked when the
 * page opens, again on member and session events, when the window gets
 * focus back or is shown again (the app's Connect window, just closed, may
 * have changed them: no event says so), and every 20 seconds.
 */
export function useLocalAgents(): Record<string, LocalAgent> | null {
  const slug = useSlug();
  const key = [...inWorkspace(slug), "desktop", "local-agents"];
  const answers = !!bridge()?.localAgents;
  const answer = useQuery({
    queryKey: key,
    queryFn: async () => {
      const agents = (await bridge()?.localAgents?.()) ?? [];
      return Object.fromEntries(agents.map((a) => [a.agent, a]));
    },
    enabled: answers,
    refetchInterval: REREAD_MS,
  });
  const { refetch } = answer;
  useEffect(() => {
    if (!answers) return;
    const again = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [answers, refetch]);
  useFollowFeed(answers ? [key] : [], { only: ["member", "session"] });
  return answers && answer.isSuccess ? answer.data : null;
}
