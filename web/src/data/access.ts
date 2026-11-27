// What the signed-in member may do: the one place the web app asks it, so
// that what it offers and what the server accepts agree.
//
// The rules are the server's (internal/engine): each change has a least role
// (`register(…, core.RoleAdmin, …)`); a membership that is read-only or
// suspended may make no change at all (apply.go); one limited to some
// projects may change nothing in another project (cx.go, `emit`); and only
// the one who made a comment, a file or a question, or an admin, may take
// it away. A rule the server checks against rows the browser may not have
// is left to the server: the app offers the control and shows the refusal.

import { useMemo } from "react";
import { useMe } from "@/data/selectors";
import { getState } from "@/data/store";
import type { Member, Task } from "@/types/core";
import type { Doc } from "@/types/docs";

export interface Access {
  /** May change anything at all: not read-only, not suspended. */
  write: boolean;
  /** May change content in this project (a task, a comment, a page); no project: the workspace's own pages and views. */
  edit(projectId?: string): boolean;
  /**
   * May change this task: edit it in its project, and it is not in the
   * trash (a trashed task is read-only for everyone until it is restored).
   * The one test every control on a task asks.
   */
  editTask(task: Pick<Task, "project_id" | "deleted_at">): boolean;
  /** May take away or change what this person made (a comment, a file, a question, a view): their own, or anyone's as an admin. */
  editMadeBy(userId: string | undefined, projectId?: string): boolean;
  /** May run the workspace: projects, statuses, labels, people, agents, automation, secrets. */
  administer: boolean;
  /**
   * May make this agent tokens, and see and revoke them: an admin, all of
   * them; the person who answers for it, those they made (internal/server/tokens.go).
   */
  agentTokens(agent: Pick<Member, "responsible_id">): boolean;
  /** May do what only an owner may: delete the workspace, make someone an owner. */
  own: boolean;
}

const NOTHING: Access = {
  write: false,
  edit: () => false,
  editTask: () => false,
  editMadeBy: () => false,
  administer: false,
  agentTokens: () => false,
  own: false,
};

/**
 * Whether a member may be given work in a project (a task assigned to them,
 * waiting on them, a question asked of them): only one who may read it. The
 * server refuses the rest (personOnTask in internal/engine). No project:
 * anyone.
 */
export function mayBeGivenWork(member: Member, projectId?: string): boolean {
  const projects = member.scope?.projects ?? [];
  return !projectId || projects.length === 0 || projects.includes(projectId);
}

/** What a member may do. Outside a component, pass getState().me. */
export function can(me: Member | null | undefined): Access {
  if (!me) return NOTHING;
  const write = !me.scope?.read_only && !me.suspended_at && !me.removed_at;
  const projects = me.scope?.projects ?? [];
  const admin = write && (me.role === "admin" || me.role === "owner");
  const edit = (projectId?: string) => write && (!projectId || projects.length === 0 || projects.includes(projectId));
  return {
    write,
    edit,
    editTask: (task) => !task.deleted_at && edit(task.project_id),
    editMadeBy: (userId, projectId) => edit(projectId) && (admin || (!!userId && userId === me.user_id)),
    administer: admin,
    agentTokens: (agent) => admin || (write && agent.responsible_id === me.user_id),
    own: write && me.role === "owner",
  };
}

/** What the signed-in member may do; it changes when their role or limits do. */
export function useCan(): Access {
  const me = useMe();
  return useMemo(() => can(me), [me]);
}

/**
 * True unless the person is limited to some projects and the page is tied
 * to another. The server sends such a person no page of another project; one
 * that is moved out of theirs while they look is still in the copy.
 */
function withinMyProjects(doc: Doc): boolean {
  const mine = getState().me?.scope?.projects;
  return !doc.project_id || !mine?.length || mine.includes(doc.project_id);
}

/**
 * Whether this person may see a page: a private one shows to its owner and
 * those it is shared with, a project's to those who see the project. Asked
 * of every page the copy holds before it is shown: one whose access changed
 * while the app was open stays in the copy.
 */
export const canSeePage = (doc: Doc, userId: string) =>
  (!doc.owner_id || doc.owner_id === userId || !!doc.shared_with?.includes(userId)) && withinMyProjects(doc);
