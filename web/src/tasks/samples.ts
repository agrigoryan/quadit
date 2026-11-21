// The sample tasks a workspace can start with, in a project "Getting
// started": asking the server for them, where they are, and what is left of
// them. Which tasks are samples is what their project lists
// (Project.samples), never their "Sample" label, which is for the person.

import { api, workspacePath } from "@/data/api";
import { getState, type StoreState, useStore } from "@/data/store";
import type { Dict } from "@/data/store";
import type { Member, Project, Task } from "@/types/core";

/**
 * Asks the server for the samples (POST /samples) and gives their project.
 * The third is for `agent`, an agent member's id, when given; while the
 * samples are there the server makes nothing more, and gives that agent
 * the third only while it has nobody.
 */
export async function askForSamples(slug: string, agent?: string): Promise<Project> {
  const out = await api.post<{ project: Project }>(workspacePath(slug, "/samples"), agent ? { agent } : {});
  return out.project;
}

/**
 * askForSamples in the open workspace, then waits until the feed has
 * brought the samples into the store, so that the page opened on them shows
 * them at once. It waits ARRIVAL_WAIT_MS at most: the page then fills in when
 * they come.
 */
export async function addSamples(agent?: string): Promise<Project> {
  const project = await askForSamples(getState().slug, agent);
  await arrival(project.id);
  return project;
}

const ARRIVAL_WAIT_MS = 5000;

/** Resolves once the store holds the project with its samples: it names them last, after its tasks are made. */
function arrival(projectId: string): Promise<void> {
  const here = (s: StoreState) => (s.collections.projects[projectId]?.samples?.length ?? 0) > 0;
  if (here(getState())) return Promise.resolve();
  return new Promise((done) => {
    const finish = () => {
      stop();
      clearTimeout(timer);
      done();
    };
    const stop = useStore.subscribe((s) => here(s) && finish());
    const timer = setTimeout(finish, ARRIVAL_WAIT_MS);
  });
}

/** The address of the samples' task list. */
export const samplesPath = (slug: string, project: Pick<Project, "key">) => `/${slug}/p/${project.key}/tasks`;

/** What is left of a project's samples: those not in the trash, and the agent the third is for, when it is one. */
export interface SamplesLeft {
  tasks: Task[];
  forAgent?: { key: string; agent: string };
}

/**
 * The samples of `project` that are not in the trash, from the live tasks
 * and members by id; null when none are, or the project was not made with
 * samples.
 */
export function samplesLeft(project: Project, tasks: Dict<Task>, members: Dict<Member>): SamplesLeft | null {
  const ids = project.samples ?? [];
  const left = ids.flatMap((id) => tasks[id] ?? []);
  if (left.length === 0) return null;
  const third = ids[2] ? tasks[ids[2]] : undefined;
  const agent = third?.assignee_id ? members[third.assignee_id] : undefined;
  return {
    tasks: left,
    forAgent: third && agent?.kind === "agent" ? { key: third.key, agent: agent.name } : undefined,
  };
}
