// Markdown in and out of the browser: picking a file, saving one.

const MARKDOWN = ".md,.markdown,.txt,text/markdown,text/plain";

/** Asks for a Markdown file; resolves with its name and text, or null if none was picked. */
export function pickMarkdown(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = MARKDOWN;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then(
        (text) => resolve({ name: file.name, text }),
        () => resolve(null),
      );
    };
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export function saveText(fileName: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A page title as a safe file name. */
export const fileNameOf = (title: string) => (title.trim().replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").slice(0, 80) || "page") + ".md";

/** A Markdown file's title: its first heading, else the file's name. */
export function titleOf(markdown: string, fileName: string): { title: string; body: string } {
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(markdown);
  if (m) return { title: (m[1] as string).trim(), body: markdown.slice(m[0].length) };
  return { title: fileName.replace(/\.(md|markdown|txt)$/i, ""), body: markdown };
}
