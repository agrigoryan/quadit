// Picking which events a webhook or a rule listens to: the common types
// first, then every other type the server's feed carries, and a line for
// patterns ("epic.*").

import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { Badge } from "@/ui/badge";
import { Input } from "@/ui/input";
import { Checkbox } from "@/settings/ui/form";
import { EVENT_GROUPS, FALLBACK_EVENTS, loadEventTypes } from "@/settings/automation/data";

/** "a task changes" for "task.updated"; the bare type when it has no name here. */
export const eventName = (type: string) => tMaybe(`auto.event.${type}`, type);

const parseOther = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The server's event types; the short built-in list until (or unless) the server answers. */
function useEventTypes(): string[] {
  const [types, setTypes] = useState(FALLBACK_EVENTS);
  useEffect(() => {
    let current = true;
    void loadEventTypes().then((list) => current && setTypes(list));
    return () => {
      current = false;
    };
  }, []);
  return types;
}

interface Group {
  id: string;
  types: string[];
}

/** The common families first, as far as the server knows their types; then the rest by entity. */
function groupTypes(all: string[]): { common: Group[]; rest: Group[] } {
  const known = new Set(all);
  const common = EVENT_GROUPS.map((g) => ({ id: g.id, types: g.types.filter((type) => known.has(type)) })).filter(
    (g) => g.types.length > 0,
  );
  const taken = new Set(common.flatMap((g) => g.types));
  const rest: Group[] = [];
  for (const type of all) {
    if (taken.has(type)) continue;
    const id = type.split(".")[0] ?? type;
    const group = rest.find((g) => g.id === id);
    if (group) group.types.push(type);
    else rest.push({ id, types: [type] });
  }
  return { common, rest };
}

interface Props {
  /** Empty means every event. */
  value: string[];
  onChange: (types: string[]) => void;
}

export function EventPicker({ value, onChange }: Props) {
  const all = useEventTypes();
  const { common, rest } = useMemo(() => groupTypes(all), [all]);
  const listed = (type: string) => all.includes(type);
  // The line shows the types and patterns that have no box; once the person
  // types in it, what they typed is kept as typed.
  const [draft, setDraft] = useState<string | null>(null);
  const other = draft ?? value.filter((v) => !listed(v)).join(", ");
  const restPicked = rest.reduce((n, g) => n + g.types.filter((name) => value.includes(name)).length, 0);
  const [more, setMore] = useState(false);

  /** Listed types in the server's order, then the rest as typed; each once. */
  const ordered = (list: string[]) => {
    const once = [...new Set(list)];
    return [...all.filter((k) => once.includes(k)), ...once.filter((v) => !listed(v))];
  };

  const toggle = (type: string, on: boolean) => {
    if (!on && draft !== null)
      setDraft(
        parseOther(draft)
          .filter((v) => v !== type)
          .join(", "),
      );
    onChange(ordered(on ? [...value, type] : value.filter((v) => v !== type)));
  };

  const type = (text: string) => {
    const before = parseOther(other);
    setDraft(text);
    onChange(ordered([...value.filter((v) => !before.includes(v)), ...parseOther(text)]));
  };

  const groups = (list: Group[]) => (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
      {list.map((group) => (
        <fieldset key={group.id} className="flex min-w-0 flex-col gap-1">
          <legend className="mb-1 text-xs font-medium text-ink-2">
            {tMaybe(`auto.eventGroup.${group.id}`, group.id)}
          </legend>
          {group.types.map((name) => (
            <Checkbox key={name} checked={value.includes(name)} onChange={(on) => toggle(name, on)}>
              {/* A long type may wrap, but only after its dot. */}
              <span className="font-mono text-xs">
                {name.split(".").map((part, i) => (
                  <Fragment key={i}>
                    {i > 0 && (
                      <>
                        .<wbr />
                      </>
                    )}
                    {part}
                  </Fragment>
                ))}
              </span>
            </Checkbox>
          ))}
        </fieldset>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-line p-2.5">
      <p className="text-xs text-ink-3">
        {value.length === 0 ? t("auto.events.allHint") : t("auto.events.someHint", { n: value.length })}
      </p>
      {groups(common)}
      {rest.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
            className="flex items-center gap-1 self-start rounded-sm text-xs font-medium text-ink-2 hover:text-ink"
          >
            <ChevronRight className={cx("size-3.5 transition-transform", more && "rotate-90")} aria-hidden />
            {t("auto.events.more")}
            {restPicked > 0 && (
              <span className="font-normal text-ink-3">{t("auto.events.moreCount", { n: restPicked })}</span>
            )}
          </button>
          {more && groups(rest)}
        </>
      )}
      <Input
        value={other}
        onChange={(e) => type(e.target.value)}
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
