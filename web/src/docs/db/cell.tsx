// One editable value of a row. Reading, it is a CellValue; editing, it is
// the editor for its kind of property: a text box in place, or a list that
// opens beside it. The table, a row's property list and the form all use it.

import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { isDay } from "@/lib/days";
import { t } from "@/lib/i18n";
import { useMembers } from "@/lib/selectors";
import { docTitle, useRows } from "@/docs/data";
import { addOption } from "@/docs/db/actions";
import { asList, CellValue, CheckMark } from "@/docs/db/cell-value";
import type { Value } from "@/docs/db/formula";
import { formulaText } from "@/docs/db/formula-values";
import { OptionPicker } from "@/docs/db/option-picker";
import { isComputed } from "@/docs/db/prop-meta";
import type { DBProperty } from "@/lib/types-docs";
import { Avatar } from "@/ui/avatar";
import { PickerList } from "@/ui/picker";
import { Popover, PopoverAnchor, PopoverContent } from "@/ui/popover";

export interface CellProps {
  prop: DBProperty;
  stored: unknown;
  shown: Value | undefined;
  editing: boolean;
  onEditing: (on: boolean) => void;
  /** The new value to store; null clears the cell. */
  onChange: (value: unknown) => void;
  /** A character typed on the cell before it was opened: the editor starts with it. */
  seed?: string;
  wrap?: boolean;
  /** Shown faintly while the cell is empty. */
  placeholder?: string;
  className?: string;
}

const INPUT_TYPES = ["text", "number", "url", "date"];

/** Whether typing on a cell of this kind should start writing into it. */
export const takesTyping = (prop: DBProperty) => prop.type === "text" || prop.type === "number" || prop.type === "url";

interface InputProps {
  kind: string;
  initial: string;
  seed?: string;
  label: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

/** A text box that takes the place of a value: Enter or leaving it saves, Escape gives up. */
export function CellInput({ kind, initial, seed, label, onCommit, onCancel }: InputProps) {
  const [text, setText] = useState(seed ?? initial);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && text !== initial) onCommit(text);
    else onCancel();
  };
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === "Tab") {
      finish(true); // and let the table move on
    } else {
      e.stopPropagation();
    }
  }
  return (
    <input
      autoFocus
      aria-label={label}
      type={kind === "date" ? "date" : "text"}
      inputMode={kind === "number" ? "decimal" : kind === "url" ? "url" : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => !seed && kind !== "date" && e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="h-full min-h-7 w-full min-w-0 bg-surface px-2 text-sm text-ink outline-none ring-2 ring-accent ring-inset"
    />
  );
}

/** What the text typed into a cell becomes; undefined when it cannot be stored. */
function parseInput(prop: DBProperty, text: string): unknown {
  const s = text.trim();
  if (s === "") return null;
  if (prop.type === "number") {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  if (prop.type === "date") return isDay(s) ? s : undefined;
  return prop.type === "text" ? text : s;
}

function ListEditor({
  prop,
  stored,
  onChange,
  onClose,
}: Pick<CellProps, "prop" | "stored" | "onChange"> & { onClose: () => void }) {
  const members = useMembers();
  const rows = useRows(prop.type === "relation" ? prop.config?.database : undefined);
  const items = useMemo(
    () =>
      prop.type === "member"
        ? members.map((m) => ({
            id: m.user_id,
            label: m.name,
            keywords: m.handle,
            icon: <Avatar member={m} size="xs" />,
          }))
        : rows.map((r) => ({ id: r.id, label: docTitle(r) })),
    [prop.type, members, rows],
  );
  if (prop.type === "select" || prop.type === "multi_select") {
    const multiple = prop.type === "multi_select";
    return (
      <OptionPicker
        prop={prop}
        value={asList(stored)}
        multiple={multiple}
        onClose={onClose}
        onChange={(names) => {
          for (const name of names) addOption(prop, name);
          onChange(multiple ? (names.length ? names : null) : (names[0] ?? null));
        }}
      />
    );
  }
  if (prop.type === "relation" && !prop.config?.database) {
    return <p className="w-60 px-3 py-3 text-sm text-ink-2">{t("db.relation.unset")}</p>;
  }
  const picked = asList(stored);
  return (
    <PickerList
      label={prop.name}
      items={items}
      value={picked}
      onPick={(id) => {
        if (prop.type === "member") {
          onChange(picked.includes(id) ? null : id);
          onClose();
          return;
        }
        const next = picked.includes(id) ? picked.filter((v) => v !== id) : [...picked, id];
        onChange(next.length ? next : null);
      }}
    />
  );
}

/** One value of a row, to read and to change. */
export function Cell({
  prop,
  stored,
  shown,
  editing,
  onEditing,
  onChange,
  seed,
  wrap,
  placeholder,
  className,
}: CellProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const box = cx("flex min-h-7 w-full min-w-0 items-center px-2 text-sm", wrap && "py-1", className);
  const value = <CellValue prop={prop} stored={stored} shown={shown} wrap={wrap} />;
  const empty = shown === undefined || shown === null || shown === "" || (Array.isArray(shown) && shown.length === 0);
  const hint = empty && placeholder ? <span className="truncate text-ink-3">{placeholder}</span> : null;

  if (isComputed(prop)) return <div className={cx(box, "text-ink-2")}>{value}</div>;

  if (prop.type === "checkbox") {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={stored === true}
        aria-label={prop.name}
        className={box}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(stored !== true)}
      >
        <CheckMark on={stored === true} />
      </button>
    );
  }

  if (INPUT_TYPES.includes(prop.type)) {
    if (editing) {
      return (
        <CellInput
          kind={prop.type}
          label={prop.name}
          initial={formulaText((stored ?? null) as Value)}
          seed={seed}
          onCancel={() => onEditing(false)}
          onCommit={(text) => {
            const next = parseInput(prop, text);
            if (next !== undefined) onChange(next);
            onEditing(false);
          }}
        />
      );
    }
    return (
      <div className={cx(box, "cursor-text")} onClick={() => onEditing(true)}>
        {hint ?? value}
      </div>
    );
  }

  return (
    <Popover open={editing} onOpenChange={onEditing}>
      <PopoverAnchor asChild>
        <div ref={anchor} className={cx(box, "cursor-default")} onClick={() => onEditing(!editing)}>
          {hint ?? value}
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="p-0"
        onCloseAutoFocus={(e) => e.preventDefault()}
        onKeyDown={(e) => e.stopPropagation()}
        // A click on the cell itself closes the list by its own handler.
        onInteractOutside={(e) => anchor.current?.contains(e.target as Node) && e.preventDefault()}
      >
        <ListEditor prop={prop} stored={stored} onChange={onChange} onClose={() => onEditing(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** A Cell that keeps track of being edited by itself: for a property list or a form. */
export function SelfCell(props: Omit<CellProps, "editing" | "onEditing">) {
  const [editing, setEditing] = useState(false);
  return <Cell {...props} editing={editing} onEditing={setEditing} />;
}
