// The note in the top bar that the copy on screen may be behind.

import { CloudOff, RefreshCw } from "lucide-react";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import { useDelayedFlag } from "@/lib/use-delayed-flag";
import { Tooltip } from "@/ui/tooltip";

/**
 * Says when the copy on screen may be behind: the live stream is down, or
 * edits are waiting to be sent. Shows nothing when all is well.
 */
export function ConnectionIndicator() {
  const down = useStore((s) => s.stream === "down");
  const waiting = useStore((s) => (s.offline ? s.unsent : 0));
  // A blip shorter than a second is not worth a flash in the top bar.
  const visible = useDelayedFlag(down || waiting > 0, 900);
  if (!visible) return null;
  const label = waiting > 0 ? t("conn.unsent", { n: waiting }) : t("conn.down");
  const hint = waiting > 0 ? t("conn.unsentHint") : t("conn.downHint");
  return (
    <Tooltip label={hint}>
      <output className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-wait-soft px-2 text-xs font-medium text-wait animate-fade">
        {waiting > 0 ? (
          <CloudOff className="size-3.5" aria-hidden />
        ) : (
          <RefreshCw className="size-3.5 animate-spin [animation-duration:2s]" aria-hidden />
        )}
        <span className="max-sm:hidden">{label}</span>
      </output>
    </Tooltip>
  );
}
