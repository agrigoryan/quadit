// Choosing the export and sending it up, with how far it has got.

import { useRef, useState } from "react";
import { Check, FileUp } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { fileSize, uploadFile, type UploadProgress } from "@/lib/files";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";

export interface Uploaded {
  id: string;
  name: string;
  size: number;
}

interface Props {
  accept?: string;
  label: string;
  value: Uploaded | null;
  onChange: (file: Uploaded | null) => void;
  /** Says whether an upload is under way, so the page can hold its buttons. */
  onBusy: (busy: boolean) => void;
  error?: string;
}

export function UploadField({ accept, label, value, onChange, onBusy, error }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const run = useRef<AbortController | null>(null);
  const [sending, setSending] = useState<{ name: string; progress: UploadProgress } | null>(null);
  const [failed, setFailed] = useState("");

  async function pick(file: File | undefined) {
    if (!file) return;
    run.current?.abort();
    const mine = new AbortController();
    run.current = mine;
    setFailed("");
    onChange(null);
    onBusy(true);
    setSending({ name: file.name, progress: { sent: 0, total: file.size, state: "queued" } });
    try {
      const row = await uploadFile(file, {
        signal: mine.signal,
        onProgress: (progress) => run.current === mine && setSending({ name: file.name, progress }),
      });
      if (run.current !== mine) return;
      onChange({ id: row.id, name: row.name || file.name, size: row.size ?? file.size });
    } catch (err) {
      if (run.current !== mine) return;
      if (!(err instanceof DOMException && err.name === "AbortError")) setFailed(errorMessage(err));
    } finally {
      if (run.current === mine) {
        run.current = null;
        setSending(null);
        onBusy(false);
      }
    }
  }

  const percent =
    sending && sending.progress.total > 0 ? Math.round((sending.progress.sent / sending.progress.total) * 100) : 0;
  const shown = failed || error;
  return (
    <div className="flex flex-col gap-1.5">
      <span className={shown ? "text-xs font-medium text-danger" : "text-xs font-medium text-ink-2"}>{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button onClick={() => input.current?.click()}>
          <FileUp className="size-3.5" aria-hidden />
          {value || sending ? t("import.replace") : t("import.choose")}
        </Button>
        {sending && (
          <span className="min-w-0 flex-1 text-sm" aria-live="polite">
            <span className="block truncate text-ink">{sending.name}</span>
            <span className="block text-xs text-ink-3 tnum">
              {sending.progress.state === "waiting" ? t("import.uploadWaiting") : t("import.uploading", { percent })} ·{" "}
              {fileSize(sending.progress.total)}
            </span>
          </span>
        )}
        {value && !sending && (
          <span className="min-w-0 flex-1 text-sm">
            <span className="block truncate text-ink">{value.name}</span>
            <span className="flex items-center gap-1 text-xs text-ink-3 tnum">
              <Check className="size-3 text-ok" aria-hidden />
              {t("import.uploaded")} · {fileSize(value.size)}
            </span>
          </span>
        )}
      </div>
      {sending && (
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the bar is a child element drawn to match the app; <progress> is drawn by the browser
          role="progressbar"
          aria-label={sending.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1 overflow-hidden rounded-full bg-sunken"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {shown && (
        <p role="alert" className="text-xs text-danger first-letter:uppercase">
          {shown}
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        aria-label={label}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
