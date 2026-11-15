import type { ReactNode } from "react";
import { CalendarDays, CircleSlash, CornerLeftUp, FileStack, Layers, Tag, UserRound } from "lucide-react";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { useEpics, useLabels, useLiveTasks, useMe, useMembers, useStatuses, useTemplates } from "@/lib/selectors";
import { formatDay } from "@/lib/time";
import type { Project } from "@/lib/types";
import { useListening } from "@/settings/agents/data";
import { ChoicePicker } from "@/tasks/choice-list";
import { createLabel, createLabelText, useManageLinks } from "@/tasks/manage";
import { memberItems, PRIORITIES } from "@/tasks/property-picker";
import { Avatar } from "@/ui/avatar";
import { PriorityIcon, StatusIcon } from "@/ui/icons";
import { Picker, type PickerItem } from "@/ui/picker";

/** What the create dialog collects besides the title and description. */
export interface TaskFields {
  statusId: string;
  assigneeId: string;
  priority: number;
  labelIds: string[];
  epicId: string;
  parentId: string;
  dueOn: string;
  templateId: string;
}

const NONE = "none";
const noneIcon = <CircleSlash className="size-3.5 text-ink-3" aria-hidden />;

const pill =
  "flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-xs text-ink-2 " +
  "hover:bg-hover hover:text-ink data-[state=open]:bg-hover";

function Pill({ icon, children, set }: { icon: ReactNode; children: ReactNode; set: boolean }) {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className={cx("truncate", set && "font-medium text-ink")}>{children}</span>
    </>
  );
}

interface Props {
  project: Project;
  value: TaskFields;
  onChange: (patch: Partial<TaskFields>) => void;
  /** Leave out what only one task can have: its parent and the template it starts from. */
  shared?: boolean;
  /** Called before leaving for a settings page, so the dialog can close. */
  onLeave?: () => void;
}

/** The row of properties under the description: each a small button that opens a picker. */
export function CreateFields({ project, value, onChange, shared, onLeave }: Props) {
  const manage = useManageLinks(project.id);
  const listening = useListening();
  const leaving = (link: { label: string; onSelect: () => void } | undefined) =>
    link && { label: link.label, onSelect: () => (onLeave?.(), link.onSelect()) };
  const statuses = useStatuses(project.id);
  const members = useMembers();
  const me = useMe();
  const labels = useLabels(project.id);
  const epics = useEpics(project.id);
  const templates = useTemplates(project.id);
  const tasks = useLiveTasks();

  const status = statuses.find((s) => s.id === value.statusId) ?? statuses.find((s) => s.is_default) ?? statuses[0];
  const assignee = members.find((m) => m.user_id === value.assigneeId);
  const epic = epics.find((e) => e.id === value.epicId);
  const parent = tasks.find((task) => task.id === value.parentId);
  const picked = labels.filter((l) => value.labelIds.includes(l.id));
  const template = templates.find((tp) => tp.id === value.templateId);
  const orNone = (id: string) => (id === NONE ? "" : id);

  const parentItems: PickerItem[] = [
    { id: NONE, label: t("task.noParent"), icon: noneIcon },
    ...tasks
      .filter((task) => task.project_id === project.id)
      .map((task) => ({ id: task.id, label: task.title, hint: task.key, keywords: task.key })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ChoicePicker
        label={t("prop.status")}
        placeholder={t("prop.set.status")}
        value={status?.id}
        items={statuses.map((s) => ({ id: s.id, label: s.name, icon: <StatusIcon category={s.category} /> }))}
        onPick={(id) => onChange({ statusId: id })}
        manage={leaving(manage.statuses)}
      >
        <button type="button" className={pill} aria-label={`${t("prop.status")}: ${status?.name ?? ""}`}>
          <Pill icon={status && <StatusIcon category={status.category} />} set>
            {status?.name ?? t("prop.status")}
          </Pill>
        </button>
      </ChoicePicker>

      <Picker
        label={t("prop.assignee")}
        placeholder={t("prop.set.assignee")}
        value={value.assigneeId || NONE}
        items={[
          { id: NONE, label: t("task.unassigned"), icon: noneIcon },
          ...memberItems(members, me.user_id, listening),
        ]}
        onPick={(id) => onChange({ assigneeId: orNone(id) })}
      >
        <button type="button" className={pill}>
          <Pill
            icon={assignee ? <Avatar member={assignee} size="xs" /> : <UserRound className="size-3.5" aria-hidden />}
            set={!!assignee}
          >
            {assignee?.name ?? t("prop.assignee")}
          </Pill>
        </button>
      </Picker>

      <Picker
        label={t("prop.priority")}
        placeholder={t("prop.set.priority")}
        value={String(value.priority)}
        items={PRIORITIES.map((p) => ({
          id: String(p),
          label: tMaybe(`priority.${p}`),
          icon: <PriorityIcon priority={p} title="" />,
        }))}
        onPick={(id) => onChange({ priority: Number(id) })}
      >
        <button type="button" className={pill}>
          <Pill icon={<PriorityIcon priority={value.priority} title="" />} set={value.priority > 0}>
            {value.priority > 0 ? tMaybe(`priority.${value.priority}`) : t("prop.priority")}
          </Pill>
        </button>
      </Picker>

      <ChoicePicker
        multiple
        label={t("prop.labels")}
        placeholder={t("prop.set.labels")}
        value={value.labelIds}
        items={labels.map((l) => ({
          id: l.id,
          label: l.name,
          icon: <span className="size-2.5 rounded-full" style={{ background: l.color || "var(--ink-3)" }} />,
        }))}
        onPick={(id) =>
          onChange({
            labelIds: value.labelIds.includes(id) ? value.labelIds.filter((v) => v !== id) : [...value.labelIds, id],
          })
        }
        onCreate={(name) => onChange({ labelIds: [...value.labelIds, createLabel(project.id, name)] })}
        createLabel={createLabelText}
        manage={leaving(manage.labels)}
      >
        <button
          type="button"
          className={pill}
          aria-label={`${t("prop.labels")}: ${picked.map((l) => l.name).join(", ") || t("task.noLabels")}`}
        >
          <Pill icon={<Tag className="size-3.5" aria-hidden />} set={picked.length > 0}>
            {picked.length > 0 ? picked.map((l) => l.name).join(", ") : t("prop.labels")}
          </Pill>
        </button>
      </ChoicePicker>

      {epics.length > 0 && (
        <Picker
          label={t("prop.epic")}
          placeholder={t("prop.set.epic")}
          value={value.epicId || NONE}
          items={[
            { id: NONE, label: t("task.noEpic"), icon: noneIcon },
            ...epics.map((e) => ({ id: e.id, label: e.name })),
          ]}
          onPick={(id) => onChange({ epicId: orNone(id) })}
        >
          <button type="button" className={pill}>
            <Pill icon={<Layers className="size-3.5" aria-hidden />} set={!!epic}>
              {epic?.name ?? t("prop.epic")}
            </Pill>
          </button>
        </Picker>
      )}

      {!shared && (
        <Picker
          label={t("prop.parent")}
          placeholder={t("prop.set.parent")}
          value={value.parentId || NONE}
          items={parentItems}
          onPick={(id) => onChange({ parentId: orNone(id) })}
        >
          <button type="button" className={pill}>
            <Pill icon={<CornerLeftUp className="size-3.5" aria-hidden />} set={!!parent}>
              {parent ? parent.key : t("prop.parent")}
            </Pill>
          </button>
        </Picker>
      )}

      <label className={cx(pill, "relative cursor-pointer focus-within:border-accent")}>
        <Pill icon={<CalendarDays className="size-3.5" aria-hidden />} set={!!value.dueOn}>
          {value.dueOn ? formatDay(value.dueOn) : t("prop.due")}
        </Pill>
        <input
          type="date"
          value={value.dueOn}
          onChange={(e) => onChange({ dueOn: e.target.value })}
          onClick={(e) => e.currentTarget.showPicker?.()}
          aria-label={t("prop.due")}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>

      {!shared && templates.length > 0 && (
        <Picker
          label={t("prop.template")}
          placeholder={t("prop.template")}
          value={value.templateId || NONE}
          items={[
            { id: NONE, label: t("common.none"), icon: noneIcon },
            ...templates.map((tp) => ({ id: tp.id, label: tp.name })),
          ]}
          onPick={(id) => onChange({ templateId: orNone(id) })}
        >
          <button type="button" className={pill}>
            <Pill icon={<FileStack className="size-3.5" aria-hidden />} set={!!template}>
              {template?.name ?? t("prop.template")}
            </Pill>
          </button>
        </Picker>
      )}
    </div>
  );
}
