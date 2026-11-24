// What the person asks for in the desktop app's own windows and on its
// notifications, carried out by this page: the app never calls the server
// itself. The page makes the buttons it hands the app, and answers each
// request through its own write paths, the server's refusal coming back as
// the answer.

import { useEffect } from "react";
import { mayBeGivenWork } from "@/data/access";
import { api, errorMessage, workspacePath } from "@/data/api";
import { mutate } from "@/data/mutate";
import { getProjectByKey, getRow, getRows } from "@/data/selectors";
import { getState } from "@/data/store";
import { answering } from "@/decisions/actions";
import { docPath } from "@/docs/area";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { taskPath } from "@/nav/task-link";
import { reading, replyPlace } from "@/pages/inbox-actions";
import { type CreatedToken, tokensChanged } from "@/settings/ui/tokens";
import { createTask } from "@/tasks/actions";
import { getSamplesProject, samplesPath } from "@/tasks/samples";
import { readConnection } from "@/data/listening";
import { isNotFound } from "@/data/query";
import { makeConnectCode, readConnectCode } from "@/settings/agents/data";
import type { Changes } from "@/types/changes.gen";
import type { AgentConnection } from "@/types/dashboard";
import type { Decision, DecisionOption, Member, Notification } from "@/types/core";
import type { DesktopAction, DesktopNotification, DesktopOutcome, DesktopRequest } from "@/types/desktop";

// The buttons the page hands the app, and the reply box; act() reads their requests back.

/** The button that answers a question with one of its options. */
export const pickAction = (decision: Decision, option: DecisionOption): DesktopAction => ({
  label: option.label.slice(0, LABEL_MAX),
  request: `pick:${decision.id}:${option.id}`,
});

/** The button that marks an inbox item read. */
export const readAction = (item: Notification): DesktopAction => ({
  label: t("desktop.markRead"),
  request: `read:${item.id}`,
});

/** The reply box of an inbox item, for one that can be answered in place. */
export const replyBox = (item: Notification): DesktopNotification["reply"] =>
  replyPlace(item) ? { placeholder: t("desktop.reply"), request: `reply:${item.id}` } : undefined;

const LABEL_MAX = 40;

const MESSAGE_MAX = 500;

/** Carries out one request; a refusal, the server's or the page's, is `{ok: false}` with its words. */
export async function answer(request: DesktopRequest): Promise<DesktopOutcome> {
  try {
    return await carryOut(request);
  } catch (err) {
    return refused(errorMessage(err));
  }
}

const refused = (message: string): DesktopOutcome => ({ ok: false, message: message.slice(0, MESSAGE_MAX) });

async function carryOut(request: DesktopRequest): Promise<DesktopOutcome> {
  const { slug } = getState();
  switch (request.kind) {
    case "action":
      return act(request.request, request.text);
    case "capture":
      return capture(request);
    case "agent": {
      const id = newId();
      await mutate(
        { type: "agent.create", args: { id, name: request.create.name, handle: request.create.handle } },
        undefined,
        { quiet: true },
      );
      return {
        ok: true,
        agent: { id, handle: getRow("members", id)?.handle ?? request.create.handle, name: request.create.name },
      };
    }
    case "agent-token": {
      const agent = getRow("members", request.agent);
      if (!agent || agent.kind !== "agent") return refused(t("desktop.gone"));
      const made = await api.post<CreatedToken>(workspacePath(slug, "/tokens"), {
        user: `@${agent.handle}`,
        name: request.label,
      });
      void tokensChanged(slug);
      return {
        ok: true,
        token: { id: made.info.id, secret: made.token },
        agent: { id: agent.user_id, handle: agent.handle, name: agent.name },
      };
    }
    case "revoke-token":
      await api.del(workspacePath(slug, `/tokens/${encodeURIComponent(request.token)}`));
      void tokensChanged(slug);
      return { ok: true };
    case "samples":
      return samplesForTheApp(request.agent);
    case "connect-code": {
      if (getRow("members", request.agent)?.kind !== "agent") return refused(t("desktop.gone"));
      const made = await makeConnectCode(slug, request.agent, request.tool);
      return { ok: true, id: made.id, code: made.code };
    }
    case "agent-state":
      return agentState(request.agent, request.code);
  }
}

/**
 * How far an agent is connected, for a card in the app that asks every
 * couple of seconds while it waits: the server's cheap reading of the
 * agents is shared and at most a few seconds old; a code is one row to
 * read. A code that no longer exists, or ran out unused, is gone: the card
 * offers a new one.
 */
async function agentState(agent: string, code: string | undefined): Promise<DesktopOutcome> {
  const { slug } = getState();
  const [connection, codeState] = await Promise.all([
    readConnection(agent),
    // A code replaced since, or one that ran out and was cleared away, is gone, unused.
    code
      ? readConnectCode(slug, code).then(
          (state) => ({ used: state.used, gone: state.expired && !state.used }),
          (err: unknown) => (isNotFound(err) ? { used: false, gone: true } : Promise.reject(err)),
        )
      : { used: false, gone: false },
  ]);
  if (!connection) return refused(t("desktop.gone"));
  return {
    ok: true,
    connected: connection.connection !== "not_connected",
    listening: connection.connection === "listening",
    codeUsed: codeState.used,
    codeGone: codeState.gone,
    ...heard(connection.reading, getRow("members", agent)),
  };
}

/**
 * What listens as an agent, for its card in the app: each live listener, by
 * its project's key and name (none: everything else) and what holds it;
 * whether a webhook pushes to it; and the projects of its own (those it may
 * work in) nothing hears now.
 */
function heard(
  agent: AgentConnection | undefined,
  member: Member | undefined,
): Pick<DesktopOutcome & { ok: true }, "listeners" | "pushed" | "unheard"> {
  if (!agent) return {};
  const live = agent.listeners.filter((l) => l.live);
  const listeners = live.flatMap((l) => {
    const project = l.project_id ? getRow("projects", l.project_id) : undefined;
    // A project this page does not hold is not said as everything else.
    if (l.project_id && !project) return [];
    return [
      { ...(project ? { project: { key: project.key, name: project.name } } : {}), ...(l.by ? { by: l.by } : {}) },
    ];
  });
  return {
    listeners,
    pushed: agent.listening_outside_projects && !live.some((l) => !l.project_id),
    unheard: getRows("projects")
      .filter((p) => member && mayBeGivenWork(member, p.id) && !agent.listening_projects.includes(p.id))
      .map((p) => p.key),
  };
}

/** Makes the task or the page quick capture asked for, and says where it is. */
async function capture({
  project: key,
  what,
  title,
  body,
}: Extract<DesktopRequest, { kind: "capture" }>): Promise<DesktopOutcome> {
  const { slug } = getState();
  const project = getProjectByKey(key ?? undefined);
  if (key !== null && !project) return refused(t("desktop.noProject"));
  if (what === "task") {
    if (!project) return refused(t("desktop.taskNeedsProject"));
    const taskKey = await createTask({ projectId: project.id, title, description: body });
    return { ok: true, path: taskPath(slug, taskKey) };
  }
  const id = newId();
  const args: Changes["doc.create"] = { id, title, markdown: body };
  if (project) args.project = project.id;
  await mutate({ type: "doc.create", args }, undefined, { quiet: true });
  return { ok: true, path: docPath(slug, id, project) };
}

/**
 * Says where the sample tasks are, giving the third to `agent` (an agent's
 * user id) while it has nobody. It never makes them: an install the app
 * opens again has had its own start already, and without samples the
 * workspace itself is where to go.
 */
async function samplesForTheApp(agent: string | undefined): Promise<DesktopOutcome> {
  const { slug } = getState();
  const here = getSamplesProject();
  if (!here) return { ok: true, path: `/${slug}` };
  const { third } = here.left;
  if (agent && third && !third.assignee_id) {
    if (getRow("members", agent)?.kind !== "agent") return refused(t("desktop.gone"));
    await mutate(
      { type: "task.update", args: { id: third.id, assignee: agent } },
      (tx) => tx.patch("tasks", third.id, { assignee_id: agent }),
      { quiet: true },
    );
  }
  return { ok: true, path: samplesPath(slug, here.project) };
}

/** Carries out a button the page handed the app (pickAction, readAction, replyBox). */
async function act(request: string, text: string | undefined): Promise<DesktopOutcome> {
  const [verb, id = "", option = ""] = request.split(":");
  if (verb === "pick") {
    const decision = getRow("decisions", id);
    if (!decision) return refused(t("desktop.gone"));
    const batch = answering(decision, { option });
    await mutate(batch.changes, batch.show, { quiet: true });
    return { ok: true };
  }
  const item = getRow("notifications", id);
  if (!item) return refused(t("desktop.gone"));
  if (verb === "read") {
    const batch = reading([id], true);
    await mutate(batch.changes, batch.show, { quiet: true });
    return { ok: true };
  }
  if (verb === "reply") {
    const place = replyPlace(item);
    if (!place) return refused(t("desktop.gone"));
    if (!text?.trim()) return refused(t("desktop.noReply"));
    await mutate({ type: "comment.create", args: { ...place, body: text } }, undefined, { quiet: true });
    return { ok: true };
  }
  return refused(t("desktop.unknown"));
}

/** Answers the desktop app's requests for as long as the shell is on screen. */
export function useDesktopRequests() {
  useEffect(() => window.quaditDesktop?.onRequest?.(answer), []);
}
