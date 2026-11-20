// @vitest-environment jsdom
// The lightbox (ui/media.tsx): one file over the whole screen, and, when it
// is one of several, the way from it to the ones beside it.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { FileRow } from "@/types/core";
import { Lightbox } from "@/ui/media";
import { TooltipProvider } from "@/ui/tooltip";

afterEach(cleanup);

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
    <TooltipProvider>
      <Lightbox file={file} files={files} onShow={setFile} onClose={() => setFile(null)} />
    </TooltipProvider>
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
