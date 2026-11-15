// The options of a question being asked: one editor per option, in order,
// what is wrong with them as a whole, and the button that adds one more.

import { Plus } from "lucide-react";
import { t } from "@/lib/i18n";
import { Button } from "@/ui/button";
import { OptionEditor } from "@/decisions/option-editor";
import type { NewDecisionDraft } from "@/decisions/use-new-decision";

export function NewDecisionOptions({ compose }: { compose: NewDecisionDraft }) {
  const { draft, actions } = compose;
  const { options } = draft;
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
            labelError={compose.labelError(option)}
            recommended={draft.recommended === option.id}
            reason={draft.reason}
            onChange={(fields) => actions.editOption(option.id, fields)}
            onMove={(delta) => actions.moveOption(index, delta)}
            onRemove={() => actions.removeOption(option.id)}
            onRecommend={(on) => actions.setRecommended(on ? option.id : null)}
            onReason={actions.setReason}
            onAddFiles={(files) => actions.addFiles(option.id, files)}
            onRemoveFile={(key) => actions.removeFile(option.id, key)}
            onFileRole={(key, role) => actions.setFileRole(option.id, key, role)}
          />
        ))}
      </ol>
      {compose.optionsError && (
        <p role="alert" className="text-xs text-danger">
          {compose.optionsError}
        </p>
      )}
      <Button variant="ghost" className="self-start max-sm:h-10" onClick={actions.addOption}>
        <Plus className="size-4" aria-hidden />
        {t("decision.new.addOption")}
      </Button>
    </div>
  );
}
