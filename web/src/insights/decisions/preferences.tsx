// The standing preferences beside the decision log: rules that hold until
// someone retires them. Owners and admins can add, retire and delete them;
// everyone else reads.

import { useState } from "react";
import { Archive, ChevronRight, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection, useMember } from "@/lib/selectors";
import { useMinute } from "@/lib/tick";
import { ago, exact } from "@/lib/time";
import { nameOf } from "@/detail/data";
import { ProjectGlyph } from "@/shell/sidebar";
import { useTaskLink } from "@/tasks/task-link";
import { LabelChip } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import type { Preferences } from "@/insights/decisions/data";
import { deletePreference, setRetired } from "@/insights/decisions/preference-dialog";
import { revealDecision } from "@/insights/decisions/reveal";
import type { Preference } from "@/insights/lib/types";

/** The decision a preference came from, as a link that opens its task there. */
function Source({ decisionId }: { decisionId: string }) {
  const decision = useCollection("decisions")[decisionId];
  const task = useCollection("tasks")[decision?.task_id ?? ""];
  const link = useTaskLink({ key: task?.key ?? "" });
  if (!decision || !task || decision.deleted_at || task.deleted_at) return null;
  return (
    <Link
      {...link}
      onClick={() => revealDecision(decision.id)}
      className="block truncate text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
    >
      {t("prefs.from", { question: decision.question })}
    </Link>
  );
}

interface ItemProps {
  pref: Preference;
  canEdit: boolean;
  onDelete: (pref: Preference) => void;
}

function PreferenceItem({ pref, canEdit, onDelete }: ItemProps) {
  useMinute();
  const project = useCollection("projects")[pref.project_id ?? ""];
  const labels = useCollection("labels");
  const author = useMember(pref.created_by);
  const retired = !!pref.retired_at;
  return (
    <li className="border-b border-line/70 py-2.5 pr-2 pl-4">
      <div className="flex items-start gap-1">
        <p className={cx("min-w-0 flex-1 text-sm whitespace-pre-line text-pretty", retired && "text-ink-2")}>{pref.body}</p>
        {canEdit && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={t("prefs.actions")} size="sm" className="-mt-0.5 max-md:size-9">
                <MoreHorizontal className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              {retired ? (
                <MenuItem icon={<RotateCcw />} onSelect={() => setRetired(pref, false)}>
                  {t("prefs.restore")}
                </MenuItem>
              ) : (
                <MenuItem icon={<Archive />} onSelect={() => setRetired(pref, true)}>
                  {t("prefs.retire")}
                </MenuItem>
              )}
              <MenuItem danger icon={<Trash2 />} onSelect={() => onDelete(pref)}>
                {t("prefs.delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pr-2 text-xs text-ink-2">
        {project ? (
          <span className="flex items-center gap-1.5">
            <ProjectGlyph project={project} />
            {project.name}
          </span>
        ) : (
          <span>{t("prefs.scope.workspace")}</span>
        )}
        {pref.label_ids?.map((id) => {
          const label = labels[id];
          return label ? <LabelChip key={id} name={label.name} color={label.color} /> : null;
        })}
      </div>
      <div className="mt-1 flex min-w-0 flex-col gap-0.5 pr-2">
        {pref.decision_id && <Source decisionId={pref.decision_id} />}
        <p className="flex flex-wrap gap-x-3 text-xs text-ink-3">
          <span title={exact(pref.created_at)}>{t("prefs.by", { name: nameOf(author), when: ago(pref.created_at) })}</span>
          {pref.retired_at ? <span title={exact(pref.retired_at)}>{t("prefs.retiredOn", { when: ago(pref.retired_at) })}</span> : null}
        </p>
      </div>
    </li>
  );
}

interface Props {
  prefs: Preferences;
  /** Owners and admins. */
  canEdit: boolean;
  onAdd: () => void;
  className?: string;
}

export function PreferenceList({ prefs, canEdit, onAdd, className }: Props) {
  const [showRetired, setShowRetired] = useState(false);
  const [deleting, setDeleting] = useState<Preference | null>(null);
  const none = prefs.active.length === 0;

  return (
    <aside aria-label={t("prefs.title")} className={cx("flex min-h-0 flex-col bg-surface", className)}>
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="text-sm font-semibold">{t("prefs.title")}</h2>
        {!none && <span className="text-xs text-ink-3 tnum">{prefs.active.length}</span>}
        <span className="flex-1" />
        {canEdit && (
          <Button variant="ghost" size="sm" className="max-md:h-9" onClick={onAdd}>
            <Plus className="size-3.5" aria-hidden />
            {t("prefs.add")}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        {none ? (
          <div className="px-4 py-3">
            <p className="text-sm text-ink-2">{t("prefs.empty")}</p>
            <p className="mt-0.5 text-xs text-ink-3">{t(canEdit ? "prefs.emptyHint" : "prefs.emptyHintMember")}</p>
          </div>
        ) : (
          <>
            <p className="border-b border-line/70 px-4 py-2 text-xs text-ink-3">{t("prefs.hint")}</p>
            <ul>
              {prefs.active.map((pref) => (
                <PreferenceItem key={pref.id} pref={pref} canEdit={canEdit} onDelete={setDeleting} />
              ))}
            </ul>
          </>
        )}
        {prefs.retired.length > 0 && (
          <section>
            <button
              type="button"
              aria-expanded={showRetired}
              onClick={() => setShowRetired((v) => !v)}
              className="flex h-9 w-full items-center gap-1.5 border-b border-line/70 px-3 text-left text-xs font-medium text-ink-2 hover:bg-hover focus-visible:-outline-offset-2"
            >
              <ChevronRight className={cx("size-4 text-ink-3", showRetired && "rotate-90")} aria-hidden />
              {t("prefs.retired", { n: prefs.retired.length })}
            </button>
            {showRetired && (
              <ul>
                {prefs.retired.map((pref) => (
                  <PreferenceItem key={pref.id} pref={pref} canEdit={canEdit} onDelete={setDeleting} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("prefs.delete.title")}
        description={t("prefs.delete.description")}
        size="sm"
        footer={
          <>
            <Button variant="ghost" className="max-sm:h-10" onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              className="max-sm:h-10"
              onClick={() => {
                if (deleting) deletePreference(deleting);
                setDeleting(null);
              }}
            >
              {t("prefs.delete")}
            </Button>
          </>
        }
      >
        <p className="border-l-2 border-line-strong pl-2.5 text-sm whitespace-pre-line text-ink-2">{deleting?.body}</p>
      </Dialog>
    </aside>
  );
}
