// How an agent's state is shown, on the dashboard and on the agents page:
// what it is doing, and whether anything would wake it. A state is always an
// icon and words, never colour alone.

import { CircleDashed, EarOff, Hourglass, Inbox, Loader } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import type { AgentState, AgentStateName } from "@/types/dashboard";

const looks: Record<AgentStateName, { icon: typeof Loader; tone: string }> = {
  working: { icon: Loader, tone: "bg-accent-soft text-accent-text" },
  waiting: { icon: Hourglass, tone: "bg-wait-soft text-wait" },
  has_work: { icon: Inbox, tone: "bg-sunken text-ink border-line-strong" },
  idle: { icon: CircleDashed, tone: "bg-sunken text-ink-2 border-line" },
};

/** "Working", "Waiting", "Has work", "Idle" as a small chip. */
export function AgentStateChip({ state, className }: { state: AgentStateName; className?: string }) {
  const look = looks[state] ?? looks.idle;
  const Icon = look.icon;
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-transparent px-1.5 text-xs font-medium whitespace-nowrap",
        look.tone,
        className,
      )}
    >
      <Icon className={cx("size-3", state === "working" && "animate-spin [animation-duration:2.4s]")} aria-hidden />
      {t(`ins.agent.state.${state}` as "ins.agent.state.idle")}
    </span>
  );
}

/**
 * The flag for an agent nothing would wake: no companion is holding a wait
 * for it and no webhook pushes to it. Loud when work is queued for it.
 */
export function NotListening({ urgent, className }: { urgent?: boolean; className?: string }) {
  return (
    <span
      title={t("ins.agent.notListeningHint")}
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap",
        urgent ? "bg-danger-soft text-danger" : "border border-line text-ink-3",
        className,
      )}
    >
      <EarOff className="size-3" aria-hidden />
      {t(urgent ? "ins.agent.notListeningUrgent" : "ins.agent.notListening")}
    </span>
  );
}

/** An agent that has work queued but would not hear about it. */
export const isStranded = (a: AgentState) =>
  !a.listening && a.state !== "working" && (a.waiting_on_it > 0 || a.state === "has_work");
