// @vitest-environment jsdom
// A text file in the viewer (ui/text-file.tsx): Markdown rendered without
// anything in it ever running or becoming the page's markup, the source as
// written, and what it says when the file is not text, is long, or could not
// be read.

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHOWN_TEXT_BYTES } from "@/data/file-text";
import { WithQuery } from "@/test/query";
import type { FileRow } from "@/types/core";
import { RENDERED_MARKDOWN_CHARS, TextFile } from "@/ui/text-file";

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { ran?: boolean }).ran;
});

function file(name: string): FileRow {
  return {
    id: name,
    name,
    content_type: "text/plain; charset=utf-8",
    size: 1,
    state: "ready",
    uploaded_by: "u1",
    created_at: 0,
    url: `/f/${name}`,
  };
}

/** The server answers every file with these bytes, or text. */
function serves(bytes: Uint8Array<ArrayBuffer> | string) {
  const fetch = vi.fn((_path: string) => Promise.resolve(new Response(bytes)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The server cannot be reached. */
const unreachable = () => vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

const show = (name: string, rendered = false) =>
  render(
    <MemoryRouter>
      <TextFile file={file(name)} rendered={rendered} />
    </MemoryRouter>,
    { wrapper: WithQuery },
  ).container;

const HOSTILE = [
  "# Release notes",
  "",
  "<script>window.ran = true</script>",
  "",
  '<img src="x" onerror="window.ran = true">',
  "",
  '<a href="#" onclick="window.ran = true">click</a> <iframe src="https://example.com"></iframe>',
  "",
  "[a link](javascript:window.ran=true) and [another](JaVaScRiPt:window.ran=true) and <javascript:window.ran=true>",
  "",
  "![pixel](javascript:window.ran=true) [a page](https://example.com/notes)",
].join("\n");

describe("TextFile", () => {
  it("renders Markdown, with its raw HTML as text and no script, handler or javascript: address anywhere", async () => {
    serves(HOSTILE);
    const page = show("notes.md", true);
    expect(await screen.findByRole("heading", { name: "Release notes" })).toBeTruthy();

    expect(page.querySelectorAll("script, iframe, object, embed, style")).toHaveLength(0);
    for (const element of page.querySelectorAll("*")) {
      const handlers = [...element.attributes].filter((a) => a.name.toLowerCase().startsWith("on"));
      expect(handlers, element.outerHTML).toEqual([]);
    }
    for (const element of page.querySelectorAll("[href], [src]")) {
      const address = element.getAttribute("href") ?? element.getAttribute("src") ?? "";
      expect(address.toLowerCase(), element.outerHTML).not.toContain("javascript:");
    }
    // The tags are shown as the words they are.
    expect(page.textContent).toContain("<script>window.ran = true</script>");
    expect(page.textContent).toContain('<img src="x" onerror="window.ran = true">');
    // A link to elsewhere opens on its own, as the app's other links do.
    const link = screen.getByRole("link", { name: "a page" });
    expect(link.getAttribute("href")).toBe("https://example.com/notes");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect((window as { ran?: boolean }).ran).toBeUndefined();
  });

  it("shows the source as written, Markdown and HTML alike", async () => {
    serves(HOSTILE);
    const page = show("notes.md");
    const source = await screen.findByText(/# Release notes/);
    expect(source.tagName).toBe("PRE");
    expect(source.textContent).toBe(HOSTILE);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(page.querySelectorAll("script, img, iframe, a")).toHaveLength(0);
  });

  it("shows a Markdown file too large to render quickly as its source, and says why", async () => {
    const big = `# Big\n\n${"Words to read. ".repeat(Math.ceil(RENDERED_MARKDOWN_CHARS / 15))}`;
    serves(big);
    const page = show("big.md", true);
    expect(await screen.findByText("Too large to show rendered")).toBeTruthy();
    expect(page.querySelector("pre")?.textContent).toBe(big);
    expect(screen.queryByRole("heading", { name: "Big" })).toBeNull();
  });

  it("says a file is not text, and offers the file", async () => {
    serves(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    show("logo.txt");
    expect(await screen.findByText("This file cannot be shown")).toBeTruthy();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe("/f/logo.txt");
    expect(download.getAttribute("download")).toBe("logo.txt");
  });

  it("shows the first megabyte of a longer file and says so, with the whole file a click away", async () => {
    const fetch = serves(`${"x".repeat(SHOWN_TEXT_BYTES - 4)}LAST and what comes after`);
    const page = show("big.log");
    expect(await screen.findByText("Showing the first 1 MB")).toBeTruthy();
    const shown = page.querySelector("pre")?.textContent ?? "";
    expect(shown).toHaveLength(SHOWN_TEXT_BYTES);
    expect(shown.endsWith("xLAST")).toBe(true);
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/f/big.log");
    expect(fetch.mock.calls[0]?.[0]).toBe("/f/big.log");
  });

  it("says plainly when the file could not be read, and reads it again on Try again", async () => {
    unreachable();
    show("run.log");
    expect(await screen.findByText("Could not load this file")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
    serves("all good");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("all good")).toBeTruthy();
  });
});
