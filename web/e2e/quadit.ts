// The `test` every spec imports: Playwright's, signed in as the owner the
// global set-up made, with two fixtures more.
//
//   quadit    the product's own CLI, run as the owner or as an agent
//             (seeding and checking what reached the server go through it,
//             never the database)
//   project   a new project made for this test alone, so tests that change
//             state never meet

import { createHash } from "node:crypto";
import { type APIRequestContext, type Browser, expect, test as base } from "@playwright/test";
import { currentRun, quadit, WORKSPACE } from "./run";

export { expect } from "@playwright/test";

/** A task as `quadit --json show` gives it. */
export interface Task {
  key: string;
  title: string;
  status: string;
  priority?: string;
  assignee?: string;
  parent?: string;
}

export interface Quadit {
  /** Runs `quadit ARGS…` as the owner and gives what it printed; a refusal throws with the CLI's message. */
  cli(...args: string[]): Promise<string>;
  /** The same as the agent (@coder), with its own token. */
  agent(...args: string[]): Promise<string>;
  /** The task as the server has it now. */
  task(key: string): Promise<Task>;
}

export interface Project {
  key: string;
  name: string;
  /** Makes a task in this project through the CLI and gives its key. Fields as `quadit new` takes them: "priority=high". */
  newTask(title: string, ...fields: string[]): Promise<string>;
}

export const test = base.extend<{ quadit: Quadit; project: Project }>({
  // The run is read when a test starts: the files are loaded before the global set-up has made it.
  baseURL: async ({}, use) => use(currentRun().url),
  storageState: async ({}, use) => use(currentRun().storageState),

  quadit: async ({}, use) => {
    const run = currentRun();
    const cli = (...args: string[]) => quadit(run, run.token, args);
    const agent = (...args: string[]) => quadit(run, run.agentToken, args);
    const task = async (key: string) => (JSON.parse(await cli("--json", "show", key)) as { task: Task }).task;
    await use({ cli, agent, task });
  },

  project: async ({ quadit }, use, testInfo) => {
    // Named after the test and its attempt: a retry gets a project of its own.
    const key = projectKey(`${testInfo.testId}#${testInfo.retry}`);
    const name = `Project ${key}`;
    await quadit.cli("do", "project.create", JSON.stringify({ key, name }));
    const newTask = async (title: string, ...fields: string[]) =>
      (JSON.parse(await quadit.cli("--json", "new", key, title, ...fields)) as { key: string }).key;
    await use({ key, name, newTask });
  },
});

/** A project key from some text: "P" and five letters. */
function projectKey(seed: string) {
  const digest = createHash("sha256").update(seed).digest();
  return "P" + Array.from(digest.subarray(0, 5), (byte) => String.fromCharCode(65 + (byte % 26))).join("");
}

/**
 * A new person, invited by the owner as a member and signed in in a browser
 * of their own. `owner` is the owner's signed-in page's requests; `name`
 * makes their email too, so it must be new to the run.
 */
export async function invitedMember(browser: Browser, owner: APIRequestContext, name: string) {
  const invite = await owner.post(`/api/v1/w/${WORKSPACE.slug}/invites`, { data: { role: "member" } });
  expect(invite.ok()).toBe(true);
  const { link } = (await invite.json()) as { link: string };

  const context = await browser.newContext({
    baseURL: currentRun().url,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
  });
  const accepted = await context.request.post(`/api/v1/auth/invite/${link.slice(link.lastIndexOf("/") + 1)}`, {
    data: { name, email: `${name.toLowerCase().replaceAll(" ", "-")}@example.com`, password: "a-long-member-password" },
  });
  expect(accepted.ok()).toBe(true);
  const { user } = (await accepted.json()) as { user: { id: string } };
  return { context, userID: user.id };
}
