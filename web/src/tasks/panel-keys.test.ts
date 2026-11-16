// @vitest-environment jsdom
// When a key belongs to the control it was typed on, and how the list takes
// the keys back from one (tasks/panel-keys.ts).

import { describe, expect, it } from "vitest";
import { giveKeysBackToList, isOnControl } from "@/tasks/panel-keys";

/** A key event as if typed on the first element `selector` finds in `html`. */
function typedOn(html: string, selector: string, key: string): KeyboardEvent {
  document.body.innerHTML = html;
  const target = document.querySelector(selector);
  if (!target) throw new Error(`nothing at ${selector}`);
  const event = new KeyboardEvent("keydown", { key, bubbles: true });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("isOnControl", () => {
  it("is true for any key typed into a field", () => {
    expect(isOnControl(typedOn("<input>", "input", "j"))).toBe(true);
    expect(isOnControl(typedOn("<textarea></textarea>", "textarea", " "))).toBe(true);
    expect(isOnControl(typedOn("<select></select>", "select", "Enter"))).toBe(true);
    const editor = typedOn('<div contenteditable="true">x</div>', "div", " ");
    // jsdom does not work out isContentEditable; a browser does.
    Object.defineProperty(editor.target, "isContentEditable", { value: true });
    expect(isOnControl(editor)).toBe(true);
  });

  it("leaves Space and Enter to a button, also from inside it", () => {
    expect(isOnControl(typedOn("<button>b</button>", "button", " "))).toBe(true);
    expect(isOnControl(typedOn("<button><span>b</span></button>", "span", "Enter"))).toBe(true);
    expect(isOnControl(typedOn('<div role="button">b</div>', "div", " "))).toBe(true);
    expect(isOnControl(typedOn("<details><summary>s</summary></details>", "summary", " "))).toBe(true);
    expect(isOnControl(typedOn('<div role="menuitem">m</div>', "div", "Enter"))).toBe(true);
  });

  it("leaves Enter to a link but takes Space on it", () => {
    expect(isOnControl(typedOn('<a href="#x">x</a>', "a", "Enter"))).toBe(true);
    expect(isOnControl(typedOn('<a href="#x">x</a>', "a", " "))).toBe(false);
  });

  it("takes the keys on a task's own card or row", () => {
    expect(isOnControl(typedOn('<a href="#x" data-task="t1">card</a>', "a", "Enter"))).toBe(false);
    expect(isOnControl(typedOn('<a href="#x" data-task="t1" role="button">card</a>', "a", " "))).toBe(false);
  });

  it("is false on the page itself", () => {
    expect(isOnControl(typedOn("<main><p>text</p></main>", "p", " "))).toBe(false);
    expect(isOnControl(typedOn("<main><p>text</p></main>", "main", "Enter"))).toBe(false);
  });
});

describe("giveKeysBackToList", () => {
  it("moves the focus from a control of the page to the page itself", () => {
    document.body.innerHTML = '<main tabindex="-1"><button>fold</button></main>';
    document.querySelector("button")?.focus();
    giveKeysBackToList();
    expect(document.activeElement?.tagName).toBe("MAIN");
  });

  it("leaves the focus alone outside the page: in a dialog or the panel", () => {
    document.body.innerHTML = '<main tabindex="-1"></main><aside><button>close</button></aside>';
    document.querySelector("button")?.focus();
    giveKeysBackToList();
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });
});
