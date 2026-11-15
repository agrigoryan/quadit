// How the insight pages write lengths of time: "45m", "3h 05m", "2d 4h".

import { t } from "@/lib/i18n";

const MIN = 60_000;

/** A stretch of minutes: "45m", "3h 05m", "2d 4h". */
export function minutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  if (m < 60) return t("ins.time.m", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("ins.time.hm", { h, m: String(m % 60).padStart(2, "0") });
  return t("ins.time.dh", { d: Math.floor(h / 24), h: h % 24 });
}

/** A stretch of hours as the server counts waits (3.4): "3h 24m", "2d 4h". */
export const hours = (h: number) => minutes(h * 60);

/** A stretch of milliseconds. */
export const span = (ms: number) => minutes(ms / MIN);
