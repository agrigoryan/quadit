// The sample tasks a workspace can start with, in a project "Getting
// started": asking the server for them, where they are, and what is left of
// them. Which tasks are samples is what their project lists
// (Project.samples), never their "Sample" label, which is for the person.

import { api, workspacePath } from "@/data/api";
import { getLookupEvenIfGone, getRows } from "@/data/selectors";
import { getState, type StoreState, useStore } from "@/data/store";
import type { Dict } from "@/data/store";
import type { Member, Project, Task } from "@/types/core";

/**
 * Asks the server for the samples (POST /samples) and gives their project:
 * while they are there it makes nothing more.
 */
export async function askForSamples(slug: string): Promise<Project> {
  const out = await api.post<{ project: Project }>(workspacePath(slug, "/samples"), {});
  return out.project;
}

/**
 * askForSamples in the open workspace, then waits until the feed has
 * brought the samples into the store, so that the page opened on them shows
 * them at once. It waits ARRIVAL_WAIT_MS at most: the page then fills in when
 * they come.
 */
export async function addSamples(): Promise<Project> {
  const project = await askForSamples(getState().slug);
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

/** What is left of a project's samples: those there, the third when it is, and the agent it is for, when it is one. */
export interface SamplesLeft {
  tasks: Task[];
  third?: Task;
  forAgent?: { key: string; agent: string };
}

/**
 * The samples of `project` that are there, from every task by id (gone
 * ones too) and the members by id: in the project and out of the trash,
 * archived ones included, as the server counts them. A sample moved to
 * another project is the person's task. Null when none is there, or the
 * project was not made with samples.
 */
export function samplesLeft(project: Project, tasks: Dict<Task>, members: Dict<Member>): SamplesLeft | null {
  const there = (id: string | undefined) => {
    const task = id ? tasks[id] : undefined;
    return task && !task.deleted_at && task.project_id === project.id ? task : undefined;
  };
  const ids = project.samples ?? [];
  const left = ids.flatMap((id) => there(id) ?? []);
  if (left.length === 0) return null;
  const third = there(ids[2]);
  const agent = third?.assignee_id ? members[third.assignee_id] : undefined;
  return {
    tasks: left,
    third,
    forAgent: third && agent?.kind === "agent" ? { key: third.key, agent: agent.name } : undefined,
  };
}

/** The project in the open workspace whose samples are there, with what is left of them; undefined when none is. */
export function getSamplesProject(): { project: Project; left: SamplesLeft } | undefined {
  const tasks = getLookupEvenIfGone("tasks");
  const members = getLookupEvenIfGone("members");
  for (const project of getRows("projects")) {
    const left = samplesLeft(project, tasks, members);
    if (left) return { project, left };
  }
  return undefined;
}
