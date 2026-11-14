// Picking which events a webhook or a rule listens to: the common types by
// name, and a line for anything else the server knows ("epic.*").

import { useState } from "react";
import { t, tMaybe } from "@/lib/i18n";
import { Badge } from "@/ui/badge";
import { Input } from "@/ui/input";
import { Checkbox } from "@/settings/ui/form";
import { EVENT_GROUPS, KNOWN_EVENTS } from "@/settings/automation/data";

/** "a task changes" for "task.updated"; the bare type when it has no name here. */
export const eventName = (type: string) => tMaybe(`auto.event.${type}`, type);

const parseOther = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

interface Props {
  /** Empty means every event. */
  value: string[];
  onChange: (types: string[]) => void;
}

export function EventPicker({ value, onChange }: Props) {
  // What was typed is kept as typed; the parsed types travel in `value`.
  const [other, setOther] = useState(() => value.filter((v) => !KNOWN_EVENTS.includes(v)).join(", "));
  const known = value.filter((v) => KNOWN_EVENTS.includes(v));

  const toggle = (type: string, on: boolean) => {
    const next = on ? [...known, type] : known.filter((v) => v !== type);
    onChange([...KNOWN_EVENTS.filter((k) => next.includes(k)), ...parseOther(other)]);
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line p-2.5">
      <p className="text-xs text-ink-3">{value.length === 0 ? t("auto.events.allHint") : t("auto.events.someHint", { n: value.length })}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        {EVENT_GROUPS.map((group) => (
          <fieldset key={group.id} className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-ink-2">{tMaybe(`auto.eventGroup.${group.id}`, group.id)}</legend>
            {group.types.map((type) => (
              <Checkbox key={type} checked={known.includes(type)} onChange={(on) => toggle(type, on)}>
                <span className="font-mono text-xs">{type}</span>
              </Checkbox>
            ))}
          </fieldset>
        ))}
      </div>
      <Input
        value={other}
        onChange={(e) => {
          setOther(e.target.value);
          onChange([...known, ...parseOther(e.target.value)]);
        }}
        placeholder={t("auto.events.otherPlaceholder")}
        aria-label={t("auto.events.other")}
        className="font-mono text-xs"
        spellCheck={false}
        autoCapitalize="off"
      />
    </div>
  );
}

/** The events of a webhook or rule as a few badges: "Every event", or the types, cut short. */
export function EventBadges({ types, max = 2 }: { types: string[] | undefined; max?: number }) {
  if (!types || types.length === 0) return <Badge>{t("auto.events.all")}</Badge>;
  return (
    <>
      {types.slice(0, max).map((type) => (
        <Badge key={type} className="font-mono">
          {type}
        </Badge>
      ))}
      {types.length > max && <Badge title={types.slice(max).join(", ")}>+{types.length - max}</Badge>}
    </>
  );
}
