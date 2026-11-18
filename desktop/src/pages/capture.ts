// Quick capture (src/main/capture.ts): a task or a page, made by the chosen
// workspace's own page. The last place used is offered first. What is
// typed stays bound to the workspace it was started for: when that
// workspace's window goes, the window says so and sends nowhere until the
// person picks another.

import { button, element, make } from "@/pages/dom";
import type { CaptureWhat, PagesApi, SummaryView } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const form = element<HTMLFormElement>("capture");
const none = element<HTMLParagraphElement>("none");
const workspaces = element<HTMLSelectElement>("workspace");
const projects = element<HTMLSelectElement>("project");
const title = element<HTMLInputElement>("title");
const body = element<HTMLTextAreaElement>("body");
const error = element<HTMLParagraphElement>("error");
const made = element<HTMLParagraphElement>("made");
const NO_PROJECT = "";

let views: SummaryView[] = [];
/** The workspace the draft is for, once there is one: its key and what it is called. */
let bound: { key: string; name: string } | null = null;

const keyOf = (serverId: string, workspaceId: string) => JSON.stringify([serverId, workspaceId]);

function chosen(): SummaryView | undefined {
  return views.find((v) => keyOf(v.serverId, v.summary.workspace.id) === workspaces.value);
}

function what(): CaptureWhat {
  return (form.elements.namedItem("what") as RadioNodeList).value === "page" ? "page" : "task";
}

/** The projects of the chosen workspace; a page may have none. */
function fillProjects(wanted: string | null) {
  const view = chosen();
  const options = (view?.summary.projects ?? []).map((p) => {
    const option = make("option", `${p.name} (${p.key})`);
    option.value = p.key;
    return option;
  });
  if (what() === "page") {
    const option = make("option", "No project");
    option.value = NO_PROJECT;
    options.unshift(option);
  }
  projects.replaceChildren(...options);
  if (wanted !== null && options.some((o) => o.value === wanted)) projects.value = wanted;
}

async function render() {
  const wasGone = workspaces.querySelector('option[value=""]') !== null;
  views = (await api.summaries()).filter((v) => v.listening);
  none.hidden = views.length > 0;
  form.hidden = views.length === 0;
  const options = views.map((v) => {
    const option = make("option", `${v.serverName} · ${v.summary.workspace.name}`);
    option.value = keyOf(v.serverId, v.summary.workspace.id);
    return option;
  });
  const keys = new Set(options.map((o) => o.value));
  if (bound && !keys.has(bound.key)) {
    // Its window went: nothing is sent anywhere else until the person says where.
    const gone = make("option", `${bound.name} (its window went away)`);
    gone.value = "";
    workspaces.replaceChildren(gone, ...options);
    workspaces.value = "";
    error.textContent = `The window for ${bound.name} went away: pick where this goes.`;
    fillProjects(null);
    return;
  }
  workspaces.replaceChildren(...options);
  if (bound) {
    if (wasGone) error.textContent = "";
    const project = projects.value;
    workspaces.value = bound.key;
    fillProjects(project);
    return;
  }
  const last = await api.lastCapture();
  if (last) {
    const key = keyOf(last.serverId, last.workspaceId);
    if (keys.has(key)) workspaces.value = key;
    (form.elements.namedItem("what") as RadioNodeList).value = last.what;
  }
  bind();
  fillProjects(last?.project ?? NO_PROJECT);
}

/** Binds the draft to the workspace chosen now. */
function bind() {
  const option = workspaces.selectedOptions[0];
  bound = option && option.value ? { key: option.value, name: option.textContent ?? "" } : null;
}

async function submit() {
  const view = chosen();
  error.textContent = "";
  made.hidden = true;
  if (!view) {
    error.textContent = "Pick where this goes.";
    return;
  }
  const submitButton = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (submitButton) submitButton.disabled = true;
  const outcome = await api.capture({
    serverId: view.serverId,
    workspaceId: view.summary.workspace.id,
    project: projects.value === NO_PROJECT ? null : projects.value,
    what: what(),
    title: title.value,
    body: body.value,
  });
  if (submitButton) submitButton.disabled = false;
  if (!outcome.ok) {
    error.textContent = outcome.message;
    return;
  }
  const path = outcome.path;
  made.replaceChildren(
    make("span", what() === "task" ? "Task created. " : "Page created. "),
    ...(path ? [button("Open", () => void api.openPath(view.serverId, path), "link")] : []),
  );
  made.hidden = false;
  title.value = "";
  body.value = "";
  title.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});
workspaces.addEventListener("change", () => {
  bind();
  error.textContent = "";
  for (const option of workspaces.querySelectorAll("option")) if (!option.value) option.remove();
  fillProjects(null);
});
for (const radio of form.querySelectorAll<HTMLInputElement>("input[name=what]")) {
  radio.addEventListener("change", () => fillProjects(projects.value));
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
});
api.onChanged(() => void render());
void render().then(() => title.focus());
