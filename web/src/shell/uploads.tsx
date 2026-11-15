import { CloudOff, Upload } from "lucide-react";
import { cx } from "@/lib/cx";
import { fileSize, type Transfer, useTransfers } from "@/lib/files";
import { t } from "@/lib/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

const percent = (sent: number, total: number) => (total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0);

/**
 * Says what is uploading and how far it has got, or that uploads wait for a
 * connection. Shows nothing when no file is on its way. Opens a list.
 *
 * It floats over the bottom of the page rather than sitting in the top bar:
 * files are mostly attached from the task panel, which covers the top bar.
 */
export function UploadsIndicator() {
  const items = useTransfers((s) => s.items);
  if (items.length === 0) return null;
  const waiting = items.filter((it) => it.state === "waiting").length;
  const stuck = waiting === items.length;
  let sent = 0;
  let total = 0;
  for (const it of items) {
    sent += it.sent;
    total += it.total;
  }
  const label = stuck
    ? t("upload.waiting", { n: waiting })
    : t("upload.sending", { n: items.length, percent: percent(sent, total) });
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-[45]">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cx(
              "pointer-events-auto flex h-8 items-center gap-2 rounded-full border bg-surface pr-3 pl-2.5 text-xs font-medium shadow-pop animate-pop",
              stuck ? "border-wait/40 text-wait" : "border-line text-ink-2",
            )}
          >
            {stuck ? (
              <CloudOff className="size-3.5" aria-hidden />
            ) : (
              <Upload className="size-3.5 text-accent-text" aria-hidden />
            )}
            <span role="status" className="tabular-nums">
              {label}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" aria-label={t("upload.title")} className="w-80 p-3">
          <p className="mb-2 text-xs font-semibold text-ink-2">{t("upload.title")}</p>
          <ul className="flex flex-col gap-2.5">
            {items.map((it) => (
              <TransferRow key={it.id} item={it} />
            ))}
          </ul>
          {waiting > 0 && <p className="mt-3 text-xs text-ink-3">{t("upload.keptHint")}</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TransferRow({ item }: { item: Transfer }) {
  const pct = percent(item.sent, item.total);
  const status =
    item.state === "waiting" ? t("upload.waitingOne") : item.state === "queued" ? t("upload.queued") : `${pct}%`;
  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{item.name}</span>
        <span className="shrink-0 text-xs text-ink-3">{fileSize(item.total)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={item.name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="mt-1 h-1 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className={cx(
            "h-full rounded-full transition-[width] duration-200",
            item.state === "waiting" ? "bg-wait" : "bg-accent",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={cx("mt-1 text-xs tabular-nums", item.state === "waiting" ? "text-wait" : "text-ink-3")}>{status}</p>
    </li>
  );
}
