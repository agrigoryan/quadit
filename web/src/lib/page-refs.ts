// How text points at a page, in the forms the server reads
// (internal/engine/notify.go): a Markdown link to doc:ID, which is the one
// to write, [Title](doc:ID); a bare doc:ID; [[Title]], the one page of that
// title; a link to a page's address in this app.

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A bare doc:ID (group 1, the id) or a [[Title]] (group 2, the title) in a run of text. */
export const pageRefInText = new RegExp(`\\bdoc:(${ID})|\\[\\[([^\\[\\]\\n]{1,200})\\]\\]`, "g");

const docAddress = new RegExp(`^doc:(${ID})$`);
const pageAddress = new RegExp(`/docs/(${ID})/?$`);

/** The id of the page a link's address points at: doc:ID, or a page's address in this app. */
export function pageIdOf(href: string): string | undefined {
  const bare = docAddress.exec(href);
  if (bare) return bare[1];
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return undefined; // not an address at all
  }
  return url.origin === window.location.origin ? pageAddress.exec(url.pathname)?.[1] : undefined;
}

/**
 * What points at a page in Markdown: [Title](doc:ID). The title is on one
 * line, with what would end the link's words (a bracket) or a table's cell
 * (a bar) escaped.
 */
export const pageLink = (title: string, id: string) =>
  `[${title
    .replace(/[\\[\]|]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim()}](doc:${id})`;

/** A Markdown link in a run of text: its words (group 1, escaped as Markdown escapes them) and its address (group 2). */
export const linkInText = /\[((?:\\.|[^[\]\\\n])*)\]\(([^()\s]*)\)/g;

/** A link's words as they read: Markdown's escapes taken out. */
export const linkWords = (escaped: string) => escaped.replace(/\\(.)/g, "$1");
