// @vitest-environment jsdom
// The lightbox (ui/media.tsx): one file over the whole screen, picture,
// video or text, with its name and its download; and, when it is one of
// several, the way from it to the ones beside it.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WithQuery } from "@/test/query";
import type { FileRow } from "@/types/core";
import { Lightbox } from "@/ui/media";
import { RENDERED_MARKDOWN_CHARS } from "@/ui/text-file";
import { TooltipProvider } from "@/ui/tooltip";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function picture(name: string, content_type = "image/png"): FileRow {
  return {
    id: name,
    name,
    content_type,
    size: 1,
    state: "ready",
    uploaded_by: "u1",
    created_at: 0,
    url: `/files/${name}`,
  };
}

/** A lightbox open on the first of `files`, moving as its arrows ask. */
function Open({ files }: { files: FileRow[] }) {
  const [file, setFile] = useState<FileRow | null>(files[0] ?? null);
  return (
    <MemoryRouter>
      <WithQuery>
        <TooltipProvider>
          <Lightbox file={file} files={files} onShow={setFile} onClose={() => setFile(null)} />
        </TooltipProvider>
      </WithQuery>
    </MemoryRouter>
  );
}

const shown = () => screen.getByRole("dialog").querySelector("img, video")?.getAttribute("src");

describe("Lightbox", () => {
  it("moves to the next and the previous file with its arrows", () => {
    render(<Open files={[picture("a.png"), picture("b.png"), picture("c.png")]} />);
    expect(shown()).toBe("/files/a.png");
    expect(screen.getByText("1 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(shown()).toBe("/files/b.png");
    expect(screen.getByText("2 / 3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(shown()).toBe("/files/a.png");
  });

  it("moves with the arrow keys, and goes round at the ends", () => {
    render(<Open files={[picture("a.png"), picture("b.png"), picture("c.png")]} />);
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(shown()).toBe("/files/c.png");

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(shown()).toBe("/files/a.png");

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(shown()).toBe("/files/b.png");
  });

  it("leaves the arrow keys to a video that has them", () => {
    render(<Open files={[picture("a.mp4", "video/mp4"), picture("b.png")]} />);
    const video = screen.getByRole("dialog").querySelector("video");
    expect(video).toBeTruthy();

    fireEvent.keyDown(video!, { key: "ArrowRight" });
    expect(shown()).toBe("/files/a.mp4");
  });

  it("has no arrows when the file is the only one", () => {
    render(<Open files={[picture("a.png")]} />);
    expect(shown()).toBe("/files/a.png");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByText("1 / 1")).toBeNull();
  });
});

describe("Lightbox with text files", () => {
  /** The server, answering each file's address with its text. */
  function serves(texts: Record<string, string>) {
    vi.stubGlobal("fetch", (path: string) => Promise.resolve(new Response(texts[path] ?? "")));
  }
  const text = (name: string, content_type = "text/plain; charset=utf-8") => picture(name, content_type);

  it("moves across pictures and text alike, in their order", async () => {
    serves({ "/files/plan.md": "# The plan\n\nShip it.", "/files/data.json": '{"ok": true}' });
    render(<Open files={[text("plan.md"), text("data.json", "application/json"), picture("a.png")]} />);
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("heading", { name: "The plan" })).toBeTruthy();
    expect(within(dialog).getByText("1 / 3")).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(await within(dialog).findByText('{"ok": true}')).toBeTruthy();
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(shown()).toBe("/files/a.png");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(await within(dialog).findByRole("heading", { name: "The plan" })).toBeTruthy();
  });

  it("names the file and always offers its download, a picture as much as text", () => {
    render(<Open files={[picture("a.png"), picture("b.png")]} />);
    const dialog = screen.getByRole("dialog", { name: "a.png" });
    const download = within(dialog).getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe("/files/a.png");
    expect(download.getAttribute("download")).toBe("a.png");
  });

  it("shows Markdown rendered or as its source, at a choice", async () => {
    serves({ "/files/plan.md": "# The plan" });
    render(<Open files={[text("plan.md")]} />);
    const dialog = screen.getByRole("dialog", { name: "plan.md" });
    expect(await within(dialog).findByRole("heading", { name: "The plan" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Source" }));
    expect(within(dialog).getByText("# The plan").tagName).toBe("PRE");
    expect(within(dialog).queryByRole("heading", { name: "The plan" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Rendered" }));
    expect(within(dialog).getByRole("heading", { name: "The plan" })).toBeTruthy();
  });

  it("puts the focus on the text of each text file it comes to, by key or by button, so the keys scroll it", async () => {
    serves({ "/files/run.log": "one", "/files/b.log": "two" });
    render(<Open files={[picture("a.png"), text("run.log"), text("b.log")]} />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "run.log" }));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "b.log" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous" }));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "run.log" }));
  });

  it("opens Markdown too large to render on its source, with the choice held there", async () => {
    serves({ "/files/big.md": `# Big\n\n${"Words. ".repeat(RENDERED_MARKDOWN_CHARS)}` });
    render(<Open files={[text("big.md")]} />);
    const dialog = screen.getByRole("dialog", { name: "big.md" });
    expect(await within(dialog).findByText("Too large to show rendered")).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Source" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "Rendered" })).toBeDisabled();
  });

  it("starts on the text, so the keys scroll it", async () => {
    serves({ "/files/run.log": "one\ntwo" });
    render(<Open files={[text("run.log")]} />);
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "run.log" }));
  });

  it("does not move when the arrow keys pick between Rendered and Source", async () => {
    serves({ "/files/plan.md": "# The plan", "/files/b.md": "# B" });
    render(<Open files={[text("plan.md"), text("b.md")]} />);
    const dialog = screen.getByRole("dialog");
    const source = within(dialog).getByRole("radio", { name: "Rendered" });
    fireEvent.keyDown(source, { key: "ArrowRight" });
    expect(within(dialog).getByText("1 / 2")).toBeTruthy();
  });
});
