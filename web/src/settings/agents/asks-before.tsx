// "Asks before…": the changes an agent must get a person's approval for.
// A new agent starts with the server's own list (what cannot be taken back,
// and what reaches outside the workspace); the form shows that list ticked
// and lets it be changed. What is saved is scope.needs_approval: the change
// types, with an empty list meaning it asks for nothing.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { t, tMaybe } from "@/lib/i18n";
import { Checkbox } from "@/settings/ui/form";
import { MultiPick } from "@/settings/ui/multi-pick";

interface Ask {
  /** Names the line in the dictionary: agent.asks.item.<key>. */
  key: string;
  types: string[];
}

const GROUPS: { key: "deleting" | "people" | "outside"; asks: Ask[] }[] = [
  { key: "deleting", asks: [{ key: "project.delete", types: ["project.delete"] }] },
  {
    key: "people",
    asks: [
      { key: "member.add", types: ["member.add"] },
      { key: "member.remove", types: ["member.remove"] },
      { key: "workspace.update", types: ["workspace.update"] },
      { key: "secret", types: ["secret.set", "secret.delete"] },
    ],
  },
  {
    key: "outside",
    asks: [
      { key: "webhook", types: ["webhook.create", "webhook.update"] },
      { key: "integration", types: ["integration.create", "integration.update"] },
      { key: "source", types: ["source.create", "source.update"] },
    ],
  },
];

const LISTED = new Set(GROUPS.flatMap((g) => g.asks.flatMap((a) => a.types)));

/** What a new agent asks before, unless its maker says otherwise (the server's AsksFirst). */
export const ASKS_FIRST: string[] = [...LISTED];

export interface ChangeCatalog {
  /** The version of what agents can call: the server's "agent surface". */
  surface: string;
  types: string[];
}

let catalog: Promise<ChangeCatalog> | null = null;

/** Every change type the server knows, and the version of that list. Fetched once. */
export function loadChangeCatalog(): Promise<ChangeCatalog> {
  catalog ??= api
    .get<{ surface?: string; changes: { type: string }[] }>("/api/v1/changes")
    .then((r) => ({ surface: r.surface ?? "", types: r.changes.map((c) => c.type).sort() }));
  catalog.catch(() => {
    catalog = null;
  });
  return catalog;
}

function useChangeTypes(): string[] {
  const [types, setTypes] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    loadChangeCatalog()
      .then((c) => current && setTypes(c.types))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  return types;
}

interface Props {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

export function AsksBefore({ value, onChange, disabled }: Props) {
  const types = useChangeTypes();
  const has = (ask: Ask) => ask.types.every((type) => value.includes(type));
  const toggle = (ask: Ask, on: boolean) => {
    const rest = value.filter((type) => !ask.types.includes(type));
    onChange(on ? [...rest, ...ask.types] : rest);
  };
  // What the ticks above do not show: other change types, and half of a pair set from outside this form.
  const ticked = new Set(GROUPS.flatMap((g) => g.asks.filter(has).flatMap((a) => a.types)));
  const others = value.filter((type) => !ticked.has(type));
  const setOthers = (next: string[]) => onChange([...value.filter((type) => ticked.has(type)), ...next]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        {GROUPS.map((group) => (
          <div key={group.key} role="group" aria-label={t(`agent.asks.group.${group.key}`)} className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-ink-3">{t(`agent.asks.group.${group.key}`)}</p>
            {group.asks.map((ask) => (
              <Checkbox key={ask.key} checked={has(ask)} onChange={(on) => toggle(ask, on)} disabled={disabled}>
                {tMaybe(`agent.asks.item.${ask.key}`, ask.types.join(", "))}
              </Checkbox>
            ))}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-ink-3">{t("agent.asks.else")}</p>
        <MultiPick
          items={types.filter((type) => !LISTED.has(type) || others.includes(type)).map((type) => ({ id: type, label: type }))}
          value={others}
          onChange={setOthers}
          addLabel={t("agent.approvalPick")}
          empty={t("agent.asks.elseNone")}
          disabled={disabled}
        />
      </div>
      {value.length === 0 && <p className="text-xs text-ink-3">{t("agent.approvalNone")}</p>}
    </div>
  );
}
