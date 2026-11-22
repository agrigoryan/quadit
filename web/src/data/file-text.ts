// A file's text, read to be shown in the viewer (ui/text-file.tsx): the
// first megabyte of its bytes, decoded as UTF-8 (or UTF-16 with its mark),
// or null when the bytes are not text. The page reads the bytes itself, so how the server would have
// the browser treat the file (download it, show it, run it) never comes
// into it: the text only ever reaches the screen as text.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/data/api";
import { inWorkspace } from "@/data/query";
import { useStore } from "@/data/store";
import type { FileRow } from "@/types/core";

/** The most of a file the viewer shows; a longer one is cut here. */
export const SHOWN_TEXT_BYTES = 1024 * 1024;

export interface FileText {
  text: string;
  /** The file is longer than SHOWN_TEXT_BYTES and the text is its start. */
  cut: boolean;
}

/** UTF-16 when the bytes start with its byte-order mark (as a log written on Windows does), else UTF-8. */
function encodingOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return "utf-8";
}

/**
 * The text of a file's first bytes, as read with one byte more than is
 * shown, which says whether there was more. Null when the bytes are not
 * UTF-8 (or UTF-16 with its byte-order mark), or hold a NUL, which no text
 * a person reads has (binary that happens to decode).
 */
export function textOf(bytes: Uint8Array): FileText | null {
  const cut = bytes.length > SHOWN_TEXT_BYTES;
  let text: string;
  try {
    // Streamed when cut: a character the cut goes through is left out, not taken for a sign of binary.
    text = new TextDecoder(encodingOf(bytes), { fatal: true }).decode(bytes.subarray(0, SHOWN_TEXT_BYTES), {
      stream: cut,
    });
  } catch {
    return null;
  }
  return text.includes("\0") ? null : { text, cut };
}

/**
 * Reads a file's text for showing it: null data when it is not text. A
 * failed or slow read (api.bytes gives it thirty seconds) fails at once,
 * not after more tries, and while the server cannot be reached it fails
 * rather than waits: someone is looking at it, and is offered "Try again".
 */
export function useFileText(file: FileRow) {
  const slug = useStore((s) => s.slug);
  return useQuery({
    queryKey: [...inWorkspace(slug), "file-text", file.id],
    queryFn: async ({ signal }) => textOf(await api.bytes(file.url, SHOWN_TEXT_BYTES + 1, signal)),
    // A file's bytes never change.
    staleTime: Infinity,
    retry: false,
    networkMode: "always",
  });
}
