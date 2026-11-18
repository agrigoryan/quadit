// The right-click menu of a server's pages. Electron has none of its own, so
// without this a person could not paste with the mouse, take a spelling
// suggestion, or copy a link.

import { clipboard, Menu, type MenuItemConstructorOptions, shell, type WebContents } from "electron";
import { browserAddress } from "@/main/origins";

/** Shows a page's right-click menu whenever it asks for one. */
export function giveContextMenu(contents: WebContents) {
  contents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (params.misspelledWord) {
      items.push(
        {
          label: "Add to Dictionary",
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: "separator" },
      );
    }
    const link = browserAddress(params.linkURL);
    if (link) {
      items.push(
        { label: "Open Link in Browser", click: () => void shell.openExternal(link) },
        { label: "Copy Link", click: () => void clipboard.writeText(link) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push(
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll" },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: "copy" });
      if (process.platform === "darwin")
        items.push({
          label: `Look Up “${params.selectionText.trim().slice(0, 30)}”`,
          click: () => contents.showDefinitionForSelection(),
        });
    }
    if (params.mediaType === "image" && params.hasImageContents) {
      items.push({ label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) });
    }
    while (items.at(-1)?.type === "separator") items.pop();
    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
}
