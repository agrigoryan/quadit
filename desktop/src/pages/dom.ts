// What the app's pages build their HTML with. Text always goes in as text
// (textContent), never as HTML: much of it comes from servers.

/** The element with `id`, which the page's HTML must have. */
export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found as T;
}

/** A new element holding `text`, with `className`. */
export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (text) made.textContent = text;
  if (className) made.className = className;
  return made;
}

/** A button that runs `onClick`; `label` names it for a screen reader when its text alone does not. */
export function button(text: string, onClick: () => void, className = "", label = ""): HTMLButtonElement {
  const made = make("button", text, className);
  made.type = "button";
  if (label) made.setAttribute("aria-label", label);
  made.addEventListener("click", onClick);
  return made;
}
