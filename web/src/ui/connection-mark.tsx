// How far an agent is connected (data/listening.ts Connection), as a small
// mark: an icon and words, the words in its tooltip and for screen readers
// when only the icon shows.

import { Radio, Unplug } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { Connection } from "@/data/listening";
import { Tooltip } from "@/ui/tooltip";

const looks: Record<Connection, { icon: typeof Radio; tone: string }> = {
  listening: { icon: Radio, tone: "text-ok" },
  connected: { icon: Radio, tone: "text-ink-3" },
  not_connected: { icon: Unplug, tone: "text-ink-3" },
};

/**
 * "Listening", "Connected, not listening" or "Not connected yet". The words
 * show beside the icon with `withText`, only on wide screens with "wide",
 * and otherwise only to screen readers.
 */
export function ConnectionMark({ connection, withText }: { connection: Connection; withText?: boolean | "wide" }) {
  const { icon: Icon, tone } = looks[connection];
  return (
    <Tooltip label={t(`agents.connection.${connection}Hint`)}>
      <span className={cx("inline-flex shrink-0 items-center gap-1 text-xs whitespace-nowrap", tone)}>
        <Icon className="size-3.5" aria-hidden />
        <span className={withText === true ? "" : withText === "wide" ? "max-lg:sr-only" : "sr-only"}>
          {t(`agents.connection.${connection}`)}
        </span>
      </span>
    </Tooltip>
  );
}
