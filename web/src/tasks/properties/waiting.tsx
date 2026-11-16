// Whom or what a task waits on before it can move: a person, an agent, or
// an outside event (a build, a reply, a date), with a note saying what is
// wanted. Picking an outside event asks for that note first.

import { useMemo, useState } from "react";
import { Globe } from "lucide-react";
import { mayBeGivenWork, useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useListening } from "@/data/listening";
import { useMe, useMember, useMembers } from "@/data/selectors";
import type { Task } from "@/types/core";
import { nameOf, who } from "@/detail/data";
import { setWaitingOn, setWaitingOutside, waitsOutside } from "@/tasks/actions";
import { PickerRow } from "@/tasks/properties/panel-row";
import {
  asText,
  NONE,
  OUTSIDE,
  type PanelProps,
  type PickerListProps,
  shared,
  type TaskProperty,
} from "@/tasks/properties/property";
import { memberOf, memberWord } from "@/tasks/properties/query-words";
import { memberItems, noneItem } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Input, Textarea } from "@/ui/input";
import { PickerList } from "@/ui/picker";

function useItems(tasks: Task[]) {
  // Those who may read every task's project: the server makes no task wait
  // on someone who cannot see it.
  const members = useMembers().filter((m) => tasks.every((task) => mayBeGivenWork(m, task.project_id)));
  const me = useMe();
  // Asked of the server only while the list is open.
  const listening = useListening();
  return {
    items: [
      noneItem(t("prop.nobody")),
      {
        id: OUTSIDE,
        label: t("prop.outside.pick"),
        icon: <Globe className="size-3.5 text-ink-2" aria-hidden />,
        keywords: t("prop.outside.words"),
      },
      ...memberItems(members, me.user_id, listening),
    ],
    value: shared(tasks, (task) => (waitsOutside(task) ? OUTSIDE : (task.waiting_on_id ?? NONE))),
  };
}

const pick = (tasks: Task[], id: string) => setWaitingOn(tasks, id === NONE ? null : id);

/** The list; an outside event gives way to a box for what it is. */
function WaitingList({ tasks, close }: PickerListProps) {
  const { items, value } = useItems(tasks);
  const [outside, setOutside] = useState(false);
  if (outside) return <OutsideNote tasks={tasks} onDone={close} />;
  return (
    <PickerList
      items={items}
      value={value}
      label={t("prop.set.waitingOn")}
      placeholder={t("prop.set.waitingOn")}
      onPick={(id) => {
        if (id === OUTSIDE) return setOutside(true);
        pick(tasks, id);
        close();
      }}
    />
  );
}

/** What the task waits on outside the workspace, in a few words: "the store's review", "the client's reply". */
function OutsideNote({ tasks, onDone }: { tasks: Task[]; onDone: () => void }) {
  const first = tasks[0];
  const [note, setNote] = useState(() => (first && waitsOutside(first) ? (first.waiting_on_note ?? "") : ""));
  return (
    <form
      className="flex w-60 flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setWaitingOutside(tasks, note.trim());
        onDone();
      }}
    >
      <label htmlFor="outside-note" className="text-xs font-medium text-ink-2">
        {t("prop.outside.note")}
      </label>
      <Input
        id="outside-note"
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t("prop.outside.placeholder")}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary">
          {t("prop.outside.set")}
        </Button>
      </div>
    </form>
  );
}

/** Whom or what the task waits on, and the note saying what is wanted, across both columns. */
function WaitingRow(panel: PanelProps) {
  const { task, side } = panel;
  const me = useMe();
  const on = useMember(task.waiting_on_id);
  const outside = waitsOutside(task);
  return (
    <PickerRow
      property={waiting}
      panel={panel}
      wide
      value={outside ? t("prop.outside") : on ? nameOf(on) : t("prop.nobody")}
      empty={!on && !outside}
      after={(on || outside) && <WaitingNote task={task} below={side} />}
    >
      {outside ? (
        <>
          <Globe className="size-3.5 shrink-0 text-wait" aria-hidden />
          <span className="truncate">{t("prop.outside.label")}</span>
        </>
      ) : on ? (
        on.user_id === me.user_id ? (
          <span className="flex h-5 items-center gap-1.5 rounded-sm bg-move px-1.5 font-semibold text-move-ink">
            <Avatar member={on} size="xs" />
            {t("detail.waitingYou")}
          </span>
        ) : (
          <>
            <Avatar member={on} size="xs" />
            <span className="truncate">{nameOf(on)}</span>
          </>
        )
      ) : (
        t("prop.nobody")
      )}
    </PickerRow>
  );
}

/**
 * The note that says what whoever the task waits on should do. Saved on
 * Enter or on leaving the box. It grows to show a long note whole; `below`
 * puts it on a line of its own under the name, where the column is narrow.
 */
function WaitingNote({ task, below }: { task: Task; below?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const saved = task.waiting_on_note ?? "";
  const can = useCan();

  function save() {
    if (draft === null) return;
    const next = draft.replace(/\s+/g, " ").trim();
    if (next !== saved) {
      if (waitsOutside(task)) setWaitingOutside([task], next);
      else setWaitingOn([task], task.waiting_on_id ?? null, next);
    }
    setDraft(null);
  }

  return (
    <Textarea
      bare
      autoGrow
      rows={1}
      aria-label={t("detail.waitingNote")}
      placeholder={waitsOutside(task) ? t("prop.outside.placeholder") : t("detail.waitingNotePlaceholder")}
      readOnly={!can.editTask(task)}
      value={draft ?? saved}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
        }
      }}
      className={cx(
        "w-auto min-w-32 flex-1 rounded-md border border-transparent px-1.5 py-[3px] text-sm leading-5 not-focus:text-ink-2 max-md:py-[7px] max-sm:-ml-1.5 max-sm:basis-full",
        "hover:bg-hover focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 read-only:pointer-events-none",
        below && "lg:-ml-1.5 lg:basis-full",
      )}
    />
  );
}

export const waiting = {
  name: "waiting",
  title: () => t("prop.waitingOn"),
  picker: {
    title: () => t("prop.set.waitingOn"),
    useItems,
    pick,
    List: WaitingList,
  },
  Panel: WaitingRow,
  timeline: [
    {
      field: "waiting_on_id",
      say: (c, { changes }) => {
        // Handed from someone to an outside event: the outside wait says it.
        if (!c.to) return changes.waiting_outside?.to ? null : t("timeline.waitingCleared");
        const note = asText(changes.waiting_on_note?.to);
        const name = who(asText(c.to));
        return note ? t("timeline.waitingNote", { name, note }) : t("timeline.waiting", { name });
      },
    },
    {
      field: "waiting_outside",
      say: (c, { changes }) => {
        if (!c.to) return changes.waiting_on_id ? null : t("timeline.waitingCleared");
        const note = asText(changes.waiting_on_note?.to);
        return note ? t("timeline.waitingOutsideNote", { note }) : t("timeline.waitingOutside");
      },
    },
    {
      field: "waiting_on_note",
      say: (c, { changes }) => {
        // Said together with who or what it is for, when that changed too.
        if (changes.waiting_on_id || changes.waiting_outside) return null;
        return c.to ? t("timeline.noteSet", { note: asText(c.to) }) : t("timeline.noteCleared");
      },
    },
  ],
  filter: {
    word: "waiting_on",
    title: () => t("filter.waitingOn"),
    holds: "one",
    // People first and "nothing" last, unlike the picker's list.
    useOptions: () => {
      const members = useMembers();
      const me = useMe();
      return useMemo(
        () => [
          ...memberItems(members, me.user_id),
          {
            id: OUTSIDE,
            label: t("prop.outside"),
            icon: <Globe className="size-3.5 text-ink-2" aria-hidden />,
            keywords: t("prop.outside.words"),
          },
          noneItem(t("prop.nobody")),
        ],
        [members, me.user_id],
      );
    },
    matches: (task, [on]) => {
      const outside = task.waiting_outside === true;
      if (on === OUTSIDE) return outside;
      if (on === NONE) return !outside && !task.waiting_on_id;
      return task.waiting_on_id === on;
    },
    read: (q, ctx) => {
      const id = q.waiting_on && memberOf(q.waiting_on, ctx);
      return id ? [id] : [];
    },
    address: (id, c) => memberWord(id, c),
    canBeGone: true,
  },
} satisfies TaskProperty<"waiting">;
