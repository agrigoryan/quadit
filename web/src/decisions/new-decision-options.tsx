// The options of a question being asked: one editor per option, in order,
// what is wrong with them as a whole, and the button that adds one more.
// Adding, moving, removing and uploading files to an option happen here.

import { Plus } from "lucide-react";
import { errorMessage } from "@/data/api";
import { uploadFile } from "@/data/files";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { Button } from "@/ui/button";
import { type DraftFile, type DraftOption, OptionEditor } from "@/decisions/option-editor";

/** An option with nothing in it yet. */
export const blankOption = (): DraftOption => ({ id: newId(), label: "", description: "", files: [] });

interface Props {
  options: DraftOption[];
  /**
   * Changes the list. It is given a function of the list as it is then, since
   * an upload that finishes later changes the list of that later moment.
   */
  onChange: (change: (options: DraftOption[]) => DraftOption[]) => void;
  /** The id of the option the asker recommends. */
  recommended: string | null;
  onRecommend: (id: string | null) => void;
  /** Why that one. */
  reason: string;
  onReason: (reason: string) => void;
  /** What is wrong with the options as a whole. */
  error?: string;
  /** The options found without a label when the asker tried to send. */
  unlabelled: string[];
}

export function NewDecisionOptions({
  options,
  onChange,
  recommended,
  onRecommend,
  reason,
  onReason,
  error,
  unlabelled,
}: Props) {
  const changeOption = (id: string, change: (o: DraftOption) => DraftOption) =>
    onChange((list) => list.map((o) => (o.id === id ? change(o) : o)));
  const changeFile = (id: string, key: string, fields: Partial<DraftFile>) =>
    changeOption(id, (o) => ({ ...o, files: o.files.map((f) => (f.key === key ? { ...f, ...fields } : f)) }));

  function move(index: number, delta: -1 | 1) {
    onChange((list) => {
      const next = [...list];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(index + delta, 0, moved);
      return next;
    });
  }

  /** Shows each file at once and uploads it; the option keeps it once the upload is done. */
  function addFiles(id: string, files: File[]) {
    const entries = files.map((file) => ({ key: newId(), name: file.name, source: file }));
    changeOption(id, (o) => ({ ...o, files: [...o.files, ...entries.map(({ key, name }) => ({ key, name }))] }));
    for (const entry of entries) {
      uploadFile(entry.source).then(
        (file) => changeFile(id, entry.key, { file }),
        (err) => changeFile(id, entry.key, { failed: errorMessage(err) }),
      );
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-ink-2">{t("decision.new.options")}</span>
        <span className="text-xs text-ink-3 max-sm:hidden">{t("decision.new.dropHint")}</span>
      </div>
      <ol className="flex flex-col gap-2">
        {options.map((option, index) => (
          <OptionEditor
            key={option.id}
            option={option}
            index={index}
            total={options.length}
            // A message stays only while the label is still missing.
            labelError={
              unlabelled.includes(option.id) && !option.label.trim() ? t("decision.new.needLabel") : undefined
            }
            recommended={recommended === option.id}
            reason={reason}
            onChange={(fields) => changeOption(option.id, (o) => ({ ...o, ...fields }))}
            onMove={(delta) => move(index, delta)}
            onRemove={() => onChange((list) => list.filter((o) => o.id !== option.id))}
            onRecommend={(on) => onRecommend(on ? option.id : null)}
            onReason={onReason}
            onAddFiles={(files) => addFiles(option.id, files)}
            onRemoveFile={(key) =>
              changeOption(option.id, (o) => ({ ...o, files: o.files.filter((f) => f.key !== key) }))
            }
            onFileRole={(key, role) => changeFile(option.id, key, { role })}
          />
        ))}
      </ol>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Button
        variant="ghost"
        className="self-start max-sm:h-10"
        onClick={() => onChange((list) => [...list, blankOption()])}
      >
        <Plus className="size-4" aria-hidden />
        {t("decision.new.addOption")}
      </Button>
    </div>
  );
}
