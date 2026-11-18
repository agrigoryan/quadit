// What the person asks for in the desktop app's own windows and on its
// notifications, carried out by this page: the app never calls the server
// itself. The page makes the buttons it hands the app, and answers each
// request through its own write paths, the server's refusal coming back as
// the answer.

import { useEffect } from "react";
import { api, errorMessage, workspacePath } from "@/data/api";
import { mutate } from "@/data/mutate";
import { getProjectByKey, getRow } from "@/data/selectors";
import { getState } from "@/data/store";
import { answering } from "@/decisions/actions";
import { docPath } from "@/docs/area";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { taskPath } from "@/nav/task-link";
import { reading, replyPlace } from "@/pages/inbox-actions";
import { type CreatedToken, tokensChanged } from "@/settings/ui/tokens";
import { createTask } from "@/tasks/actions";
import type { Changes } from "@/types/changes.gen";
import type { Decision, DecisionOption, Notification } from "@/types/core";
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
  }
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
