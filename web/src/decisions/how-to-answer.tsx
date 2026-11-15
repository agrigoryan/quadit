// How a question being asked is answered: with one of several options or a
// plain approval, and by whom (one person, or anyone).

import { useId } from "react";
import { ChevronDown, Users } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useMe } from "@/lib/selectors";
import type { Member } from "@/lib/types";
import { memberItems } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Picker } from "@/ui/picker";
import type { NewDecision } from "@/decisions/actions";

export type AnswerKind = NewDecision["kind"];

const ANYONE = "anyone";

interface Props {
  kind: AnswerKind;
  onKind: (kind: AnswerKind) => void;
  /** Who should answer; null for anyone. */
  ask: string | null;
  onAsk: (userId: string | null) => void;
  /** The people who can be asked. */
  people: Member[];
}

export function HowToAnswer({ kind, onKind, ask, onAsk, people }: Props) {
  const me = useMe();
  const kindId = useId();
  const asked = people.find((m) => m.user_id === ask);

  const kindButton = (value: AnswerKind, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={kind === value}
      onClick={() => onKind(value)}
      className={cx(
        "h-7 rounded-sm px-2.5 text-sm font-medium max-sm:h-9 max-sm:flex-1",
        kind === value ? "bg-surface text-ink shadow-card" : "text-ink-2 hover:text-ink",
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
          value={ask ?? ANYONE}
          onPick={(id) => onAsk(id === ANYONE ? null : id)}
          items={[
            {
              id: ANYONE,
              label: t("decision.new.anyone"),
              icon: <Users className="size-3.5 text-ink-3" aria-hidden />,
            },
            ...memberItems(people, me.user_id),
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
