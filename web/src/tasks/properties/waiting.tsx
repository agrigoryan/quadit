// Whom or what a task waits on before it can move: a person, an agent, or
// an outside event (a build, a reply, a date), with a note saying what is
// wanted. Picking an outside event asks for that note first.

import { useState } from "react";
import { Globe } from "lucide-react";
import { t } from "@/lib/i18n";
import { useListening } from "@/lib/listening";
import { useMe, useMembers } from "@/lib/selectors";
import type { Task } from "@/lib/types";
import { setWaitingOn, setWaitingOutside, waitsOutside } from "@/tasks/actions";
import { NONE, OUTSIDE, type PickerListProps, shared, type TaskProperty } from "@/tasks/properties/property";
import { memberItems, noneItem } from "@/tasks/property-picker";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { PickerList } from "@/ui/picker";

function useItems(tasks: Task[]) {
  const members = useMembers();
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

export const waiting = {
  name: "waiting",
  title: () => t("prop.waitingOn"),
  picker: {
    title: () => t("prop.set.waitingOn"),
    useItems,
    pick,
    List: WaitingList,
  },
} satisfies TaskProperty<"waiting">;
