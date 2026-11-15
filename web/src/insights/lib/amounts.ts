// How the insight pages write amounts: money and counts.

import { formatNumber } from "@/lib/i18n";

const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Money from the server's decimal string ("6.20") or a number of dollars. */
export function money(value: string | number | undefined): string {
  return amount.format(Number(value ?? 0) || 0);
}

/** Money from millionths of a dollar, as sessions record cost. */
export const moneyMicros = (micros: number | undefined) => amount.format((micros ?? 0) / 1e6);

/** A count as people read it: 116445 as "116,445". Not for keys, ids or what goes in a field. */
export const count = (n: number | undefined) => formatNumber(n ?? 0);

/** 182000 as "182K". */
export const short = (n: number | undefined) => compact.format(n ?? 0);
