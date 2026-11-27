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

/** What points at a page in Markdown: [Title](doc:ID), the title's brackets escaped so they do not end it. */
export const pageLink = (title: string, id: string) => `[${title.replace(/[\\[\]]/g, "\\$&")}](doc:${id})`;
