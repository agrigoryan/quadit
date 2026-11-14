// Small parts used across settings pages.

import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { exact } from "@/lib/time";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";
import { Loading } from "@/ui/spinner";
import type { Loaded } from "@/settings/ui/use-load";
import { Ago } from "@/ui/ago";

/** A moment as "3h" with the exact time on hover; a dash when there is none. */
export function When({ ms, className }: { ms: number | undefined; className?: string }) {
  if (!ms) return <span className={cx("text-ink-3", className)}>{t("s.never")}</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={exact(ms)} className={cx("tnum whitespace-nowrap", className)}>
      <Ago ms={ms} />
    </time>
  );
}

/** A fact with its name in front: "Last used 3h". */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-baseline gap-1 whitespace-nowrap", className)}>
      <span className="text-ink-3">{label}</span>
      <span className="text-ink-2">{children}</span>
    </span>
  );
}

/** Shows the spinner, the error with "Try again", or the page once its list is here. */
export function LoadGate<T>({ of, children }: { of: Loaded<T>; children: (data: T) => ReactNode }) {
  if (of.data !== undefined) return <>{children(of.data)}</>;
  if (of.error) {
    return <EmptyState title={t("s.loadFailed")} hint={of.error} action={<Button onClick={() => void of.reload()}>{t("common.tryAgain")}</Button>} />;
  }
  return <Loading />;
}

/** Starts a download of a same-origin address (an export, a CSV, a backup). */
export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// The colours offered for projects, statuses and labels: calm, and readable
// with white text in both themes.
export const SWATCHES = ["#6b7183", "#3451e0", "#3b82f6", "#0f8a8a", "#10b981", "#16874a", "#b7791f", "#c26a00", "#ef4444", "#d1343b", "#ec4899", "#7a6ad8"];

interface ColorProps {
  value: string;
  onChange: (color: string) => void;
  label: string;
}

/** A row of swatches, plus the browser's colour well for anything else. */
export function ColorPicker({ value, onChange, label }: ColorProps) {
  const custom = !!value && !SWATCHES.includes(value.toLowerCase());
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {SWATCHES.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === color}
          aria-label={color}
          onClick={() => onChange(color)}
          className={cx(
            "size-5 rounded-full ring-offset-2 ring-offset-surface transition-shadow",
            value.toLowerCase() === color ? "ring-2 ring-ink" : "hover:ring-2 hover:ring-line-strong",
          )}
          style={{ background: color }}
        />
      ))}
      <label
        className={cx(
          "relative flex size-5 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed border-line-strong text-2xs text-ink-3 ring-offset-2 ring-offset-surface",
          custom && "border-solid ring-2 ring-ink",
        )}
        style={custom ? { background: value } : undefined}
        title={t("s.customColor")}
      >
        {!custom && "+"}
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#6b7183"}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t("s.customColor")}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

/** A small round dot of a row's colour. */
export function Dot({ color, className }: { color?: string; className?: string }) {
  return <span className={cx("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: color || "var(--ink-3)" }} aria-hidden />;
}
