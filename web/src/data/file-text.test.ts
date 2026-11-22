// A file's text for the viewer (data/file-text.ts): the first megabyte of it,
// and nothing at all when its bytes are not text.

import { describe, expect, it } from "vitest";
import { SHOWN_TEXT_BYTES, textOf } from "@/data/file-text";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("textOf", () => {
  it("gives the whole text of a file up to a megabyte", () => {
    expect(textOf(bytes("# Plan\n\nShip it.\n"))).toEqual({ text: "# Plan\n\nShip it.\n", cut: false });
    const full = "a".repeat(SHOWN_TEXT_BYTES);
    expect(textOf(bytes(full))).toEqual({ text: full, cut: false });
    expect(textOf(new Uint8Array())).toEqual({ text: "", cut: false });
  });

  it("cuts a longer file at a megabyte and says so", () => {
    const shown = textOf(bytes("a".repeat(SHOWN_TEXT_BYTES + 1)));
    expect(shown?.cut).toBe(true);
    expect(shown?.text).toHaveLength(SHOWN_TEXT_BYTES);
  });

  it("leaves out a character the cut goes through, rather than calling the file not text", () => {
    // "é" is two bytes: the cut falls between them.
    const shown = textOf(bytes("a".repeat(SHOWN_TEXT_BYTES - 1) + "é and more"));
    expect(shown).toEqual({ text: "a".repeat(SHOWN_TEXT_BYTES - 1), cut: true });
  });

  it("reads UTF-8, without the mark some editors put at the start", () => {
    expect(textOf(bytes("﻿naïve café ✓"))).toEqual({ text: "naïve café ✓", cut: false });
  });

  it("gives null for bytes that are not text", () => {
    // The start of a PNG: not UTF-8.
    expect(textOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    // Valid UTF-8, but with a NUL byte no text a person reads has.
    expect(textOf(bytes("name\0\0\0size"))).toBeNull();
    // A character cut short at the end of a file that was not cut.
    expect(textOf(bytes("café").subarray(0, 4))).toBeNull();
  });
});
