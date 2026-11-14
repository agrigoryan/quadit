import { CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { useStore } from "@/lib/store";
import { Tooltip } from "@/ui/tooltip";

/**
 * Says when the copy on screen may be behind: the live stream is down, or
 * edits are waiting to be sent. Shows nothing when all is well.
 */
export function ConnectionIndicator() {
  const down = useStore((s) => s.stream === "down");
  const waiting = useStore((s) => (s.offline ? s.unsent : 0));
  // A blip shorter than a second is not worth a flash in the top bar.
  const [visible, setVisible] = useState(false);
  const trouble = down || waiting > 0;

  useEffect(() => {
    if (!trouble) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 900);
    return () => clearTimeout(timer);
  }, [trouble]);

  if (!visible) return null;
  const label = waiting > 0 ? t("conn.unsent", { n: waiting }) : t("conn.down");
  const hint = waiting > 0 ? t("conn.unsentHint") : t("conn.downHint");
  return (
    <Tooltip label={hint}>
      <span role="status" className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-wait-soft px-2 text-xs font-medium text-wait animate-fade">
        {waiting > 0 ? <CloudOff className="size-3.5" aria-hidden /> : <RefreshCw className="size-3.5 animate-spin [animation-duration:2s]" aria-hidden />}
        <span className="max-sm:hidden">{label}</span>
      </span>
    </Tooltip>
  );
}
