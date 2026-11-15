// A page's cover: a picture across the top of the page. It is uploaded like
// any file and the page keeps its address.

import { ImageIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { errorMessage } from "@/data/api";
import { cx } from "@/lib/cx";
import { isImage, uploadFile } from "@/data/files";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { localPath } from "@/lib/url";
import { updateDoc } from "@/docs/actions";
import type { Doc } from "@/types/docs";

/** A hidden file input and the function that opens it; the picked image becomes the page's cover. */
function useCoverUpload(docId: string): { busy: boolean; pick: () => void; input: ReactNode } {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function take(file: File | undefined) {
    if (!file) return;
    if (!isImage({ content_type: file.type })) {
      toast.error(t("docs.cover.notImage"));
      return;
    }
    setBusy(true);
    try {
      const row = await uploadFile(file);
      updateDoc(docId, { cover: row.url });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      className="hidden"
      aria-label={t("docs.cover.add")}
      onChange={(e) => {
        void take(e.target.files?.[0]);
        e.target.value = "";
      }}
    />
  );
  return { busy, pick: () => ref.current?.click(), input };
}

/** "Add cover", shown beside "Add icon" above the title of a page that has none. */
export function AddCoverButton({ docId, className }: { docId: string; className?: string }) {
  const { busy, pick, input } = useCoverUpload(docId);
  return (
    <>
      <button type="button" disabled={busy} onClick={pick} className={className}>
        <ImageIcon className="size-3.5" />
        {busy ? t("docs.cover.uploading") : t("docs.cover.add")}
      </button>
      {input}
    </>
  );
}

const control =
  "h-7 rounded-md bg-surface/90 px-2 text-xs font-medium text-ink shadow-pop backdrop-blur-sm hover:bg-surface disabled:opacity-60 max-md:h-8";

/** The cover across the top of a page, with the ways to change or remove it. Draws nothing for a page without one. */
export function PageCover({ doc, readOnly }: { doc: Doc; readOnly?: boolean }) {
  const { busy, pick, input } = useCoverUpload(doc.id);
  const src = localPath(doc.cover);
  if (!src) return null;
  return (
    <div className="group/cover relative h-[22vh] max-h-72 min-h-32 w-full bg-sunken">
      <img src={src} alt="" decoding="async" className={cx("size-full object-cover", busy && "opacity-60")} />
      {!readOnly && (
        <div className="absolute right-3 bottom-3 flex gap-1.5 opacity-0 transition-opacity group-focus-within/cover:opacity-100 group-hover/cover:opacity-100 max-md:opacity-100">
          <button type="button" disabled={busy} onClick={pick} className={control}>
            {busy ? t("docs.cover.uploading") : t("docs.cover.change")}
          </button>
          <button type="button" disabled={busy} onClick={() => updateDoc(doc.id, { cover: "" })} className={control}>
            {t("docs.cover.remove")}
          </button>
          {input}
        </div>
      )}
    </div>
  );
}
