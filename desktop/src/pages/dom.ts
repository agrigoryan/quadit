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

/** An icon of lines drawn in the text's colour (tools.css strokes it), from `paths` in a 24 by 24 box. */
export function lineIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "line-icon");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
