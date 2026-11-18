// Quick capture (src/main/capture.ts): a task or a page, made by the chosen
// workspace's own page. The last place used is offered first.

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
  const previous = workspaces.value;
  views = (await api.summaries()).filter((v) => v.listening);
  none.hidden = views.length > 0;
  form.hidden = views.length === 0;
  workspaces.replaceChildren(
    ...views.map((v) => {
      const option = make("option", `${v.serverName} · ${v.summary.workspace.name}`);
      option.value = keyOf(v.serverId, v.summary.workspace.id);
      return option;
    }),
  );
  if (previous && views.some((v) => keyOf(v.serverId, v.summary.workspace.id) === previous)) {
    workspaces.value = previous;
    fillProjects(projects.value);
    return;
  }
  const last = await api.lastCapture();
  if (last) {
    const key = keyOf(last.serverId, last.workspaceId);
    if (views.some((v) => keyOf(v.serverId, v.summary.workspace.id) === key)) workspaces.value = key;
    (form.elements.namedItem("what") as RadioNodeList).value = last.what;
  }
  fillProjects(last?.project ?? NO_PROJECT);
}

async function submit() {
  const view = chosen();
  error.textContent = "";
  made.hidden = true;
  if (!view) return;
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
workspaces.addEventListener("change", () => fillProjects(null));
for (const radio of form.querySelectorAll<HTMLInputElement>("input[name=what]")) {
  radio.addEventListener("change", () => fillProjects(projects.value));
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.close();
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
});
api.onChanged(() => void render());
void render().then(() => title.focus());
