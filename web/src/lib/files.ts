// Uploading files and telling what kind they are.

import { api, ws } from "@/lib/api";
import { getState } from "@/lib/store";
import type { FileRow } from "@/lib/types";
import { localPath } from "@/lib/url";

/** Sends one file to the workspace. Attach the returned file with `attachment.add` or inside a comment or option. */
export async function uploadFile(file: File): Promise<FileRow> {
  const slug = getState().slug;
  const row = await api.upload<FileRow>(ws(slug, `/files?name=${encodeURIComponent(file.name)}`), file, file.type);
  return { ...row, url: localPath(row.url) as string, preview_url: localPath(row.preview_url) };
}

export const isImage = (f: Pick<FileRow, "content_type"> | undefined) => !!f?.content_type.startsWith("image/");
export const isVideo = (f: Pick<FileRow, "content_type"> | undefined) => !!f?.content_type.startsWith("video/");
export const isMedia = (f: Pick<FileRow, "content_type"> | undefined) => isImage(f) || isVideo(f);

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

/** Copies text, answering whether the browser allowed it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
