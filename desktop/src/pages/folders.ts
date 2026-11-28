// The folders tied to a tool's workspaces, on its card in Connect agents
// (multi-workspace design §3.6): in a folder tied to a workspace, a tool
// that works in several works in that one; anywhere else its agent asks
// which. Shown on the card of a tool connected here and elsewhere too, and,
// right after Connect here as well, as the question of which folders work in
// each of its workspaces (the folders step), which the person may skip with
// Done. A folder is tied once chosen (the native picker, then quadit use),
// and untied with Untie: no command to type. Its nodes are drawn anew only
// when what they show changes, focus kept on the control it was on.
// Styled by tools.css.

import { button, make } from "@/pages/dom";
import { andList } from "@/shared/change-words";
import type { ConnectionRef, PagesApi, TiedFolder } from "@/shared/pages-api";

const api = () => window.quaditPages as PagesApi;

/** A workspace the tool works in, by its connection there, and the folders tied to it. */
export interface FolderPlace {
  ref: ConnectionRef;
  workspace: string;
  folders: TiedFolder[];
}

export class Folders {
  readonly element: HTMLElement;
  private drawn = "";
  private error: HTMLParagraphElement;

  /** For the tool named `tool`; `changed`: a folder was tied or untied, and the page looks again. */
  constructor(
    private tool: string,
    private changed: () => void,
  ) {
    this.element = make("section", "", "folders");
    this.element.setAttribute("aria-label", `Folders for ${tool}`);
    this.error = make("p", "", "card-error");
    this.error.setAttribute("role", "alert");
  }

  /**
   * Shows the folders of `places` (the workspace here first); `asking`: as
   * the folders step, its question for each and Done, which calls `done`.
   * No places: nothing shown.
   */
  show(places: FolderPlace[], asking: { done: () => void } | null) {
    const drawn = JSON.stringify([places, asking !== null]);
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    const focused = this.element.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.key
      : undefined;
    this.element.hidden = places.length === 0;
    this.element.classList.toggle("asking", asking !== null);
    const lead = asking
      ? [
          make(
            "p",
            `${this.tool} works in ${andList(places.map((p) => p.workspace))} now. In a folder tied to one of them, it works there; anywhere else it asks you which.`,
            "folders-lead",
          ),
        ]
      : [];
    const done = asking
      ? [button("Done", () => asking.done(), "btn btn-line btn-sm", `Done choosing folders for ${this.tool}`)]
      : [];
    this.element.replaceChildren(
      ...lead,
      ...places.map((place) => this.place(place, asking !== null)),
      this.error,
      ...done,
    );
    if (focused) this.element.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  private place({ ref, workspace, folders }: FolderPlace, asking: boolean): HTMLElement {
    const box = make("div", "", "folder-place");
    box.append(
      make("p", asking ? `Which folders work in ${workspace}?` : `Folders that work in ${workspace}`, "folders-ask"),
    );
    if (folders.length > 0) {
      const list = make("ul", "", "folder-list");
      list.append(
        ...folders.map((folder) => {
          const item = make("li");
          const untie = button(
            "Untie",
            () => void this.untie(ref, folder.path),
            "link-blue",
            `Untie ${folder.shown} from ${workspace}`,
          );
          untie.dataset.key = `untie\n${ref.workspaceId}\n${folder.path}`;
          item.append(make("code", folder.shown), " ", untie);
          return item;
        }),
      );
      box.append(list);
    } else if (!asking)
      box.append(make("p", `None yet: in any folder, ${this.tool} asks which workspace to use.`, "hint"));
    const tie = button(
      "Tie a folder…",
      () => void this.tie(ref),
      "btn btn-line btn-sm",
      `Tie a folder to ${workspace}`,
    );
    tie.dataset.key = `tie\n${ref.workspaceId}`;
    box.append(tie);
    return box;
  }

  private async tie(ref: ConnectionRef) {
    this.error.textContent = "";
    const picked = await api().pickFolder();
    if (!picked) return;
    const done = await api().tieFolder(ref, picked.path);
    if (!done.ok) this.error.textContent = done.error;
    else this.changed();
  }

  private async untie(ref: ConnectionRef, folder: string) {
    this.error.textContent = "";
    const done = await api().untieFolder(ref, folder);
    if (!done.ok) this.error.textContent = done.error;
    else this.changed();
  }
}
