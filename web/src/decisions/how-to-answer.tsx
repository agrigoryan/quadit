// How a question being asked is answered: with one of several options or a
// plain approval, and by whom (one person, or anyone).

import { useId } from "react";
import { ChevronDown, Users } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe, useMembers } from "@/lib/selectors";
import { memberItems } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Picker } from "@/ui/picker";
import type { AnswerKind, NewDecisionDraft } from "@/decisions/use-new-decision";

const ANYONE = "anyone";

/** The people who can be asked: everyone but the asker and the suspended. */
export function useAskable() {
  const me = useMe();
  return useMembers().filter((m) => m.user_id !== me.user_id && !m.suspended_at);
}

export function HowToAnswer({ compose }: { compose: NewDecisionDraft }) {
  const { draft, actions } = compose;
  const me = useMe();
  const others = useAskable();
  const kindId = useId();
  const asked = others.find((m) => m.user_id === draft.ask);

  const kindButton = (value: AnswerKind, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={draft.kind === value}
      onClick={() => actions.setKind(value)}
      className={cx(
        "h-7 rounded-sm px-2.5 text-sm font-medium max-sm:h-9 max-sm:flex-1",
        draft.kind === value ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="flex flex-col gap-1 max-sm:w-full">
        <span id={kindId} className="text-xs font-medium text-ink-2">
          {t("decision.new.kind")}
        </span>
        <div role="radiogroup" aria-labelledby={kindId} className="inline-flex gap-0.5 rounded-md bg-sunken p-0.5">
          {kindButton("choice", t("decision.new.choice"))}
          {kindButton("approval", t("decision.new.approval"))}
        </div>
      </div>
      <div className="flex flex-col gap-1 max-sm:w-full">
        <span className="text-xs font-medium text-ink-2">{t("decision.new.ask")}</span>
        <Picker
          label={t("decision.new.ask")}
          value={draft.ask ?? ANYONE}
          onPick={(id) => actions.setAsk(id === ANYONE ? null : id)}
          items={[
            {
              id: ANYONE,
              label: t("decision.new.anyone"),
              icon: <Users className="size-3.5 text-ink-3" aria-hidden />,
            },
            ...memberItems(others, me.user_id),
          ]}
        >
          <Button className="h-8! justify-between! gap-2! max-sm:h-10! max-sm:w-full">
            <span className="flex min-w-0 items-center gap-1.5">
              {asked ? <Avatar member={asked} size="xs" /> : <Users className="size-3.5 text-ink-3" aria-hidden />}
              <span className="truncate">{asked ? asked.name : t("decision.new.anyone")}</span>
            </span>
            <ChevronDown className="size-3.5 text-ink-3" aria-hidden />
          </Button>
        </Picker>
      </div>
    </div>
  );
}
