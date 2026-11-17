// Amounts as a person reads them: counts.

import { formatNumber } from "@/lib/i18n";

/** A count as people read it: 116445 as "116,445". Not for keys, ids or what goes in a field. */
export const count = (n: number | undefined) => formatNumber(n ?? 0);
