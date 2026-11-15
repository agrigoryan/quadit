// Editing a question that is still open: its wording, its details, and (for
// a choice) which option the asker recommends and why. The options
// themselves stay as asked.

import { useId, useState } from "react";
import { MOD } from "@/lib/hotkeys";
import { t } from "@/lib/i18n";
import type { Decision } from "@/types/core";
import { Input, Textarea } from "@/ui/input";
import { MentionTextarea } from "@/ui/mention-textarea";
import { updateDecision } from "@/decisions/actions";
import { optionsOf, useReturnFocus } from "@/decisions/data";
import { FormField, NativeSelect, refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";

const NONE = "";

/** Mount it only while it is open, so it starts from the question as it stands. */
export function EditDecisionDialog({ decision, onClose }: { decision: Decision; onClose: () => void }) {
  const options = optionsOf(decision);
  const [question, setQuestion] = useState(decision.question);
  const [details, setDetails] = useState(decision.details ?? "");
  const [recommended, setRecommended] = useState(decision.recommended_option_id ?? NONE);
  const [recommendation, setRecommendation] = useState(decision.recommendation ?? "");
  const errors = useFieldErrors(["question", "details", "recommended", "recommendation"]);
  const id = useId();
  useReturnFocus();

  async function submit() {
    if (!question.trim()) refuse("question", t("decision.new.needQuestion"));
    await updateDecision(decision, {
      question: question.trim(),
      details: details.trim(),
      recommended: recommended || null,
      // A reason with nothing recommended would say nothing.
      recommendation: recommended ? recommendation.trim() : "",
    });
  }

  return (
    <FormDialog
      title={t("decision.edit.title")}
      description={t("decision.edit.lead")}
      submit={t("common.save")}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <FormField label={t("decision.new.question")} htmlFor={`${id}-q`} error={errors.fields.question}>
        <Input
          id={`${id}-q`}
          autoFocus
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            errors.set("question", "");
          }}
          className="h-9! text-base! font-medium max-sm:h-10!"
        />
      </FormField>
      <FormField
        label={t("decision.new.details")}
        htmlFor={`${id}-d`}
        hint={t("decision.edit.detailsHint", { mod: MOD })}
        error={errors.fields.details}
      >
        <MentionTextarea
          id={`${id}-d`}
          value={details}
          onChange={setDetails}
          rows={3}
          placeholder={t("decision.new.detailsPlaceholder")}
          className="min-h-20 max-sm:text-base"
        />
      </FormField>
      {decision.kind === "choice" && options.length > 0 && (
        <>
          <FormField label={t("decision.edit.recommended")} htmlFor={`${id}-r`} error={errors.fields.recommended}>
            <NativeSelect
              id={`${id}-r`}
              value={recommended}
              onChange={setRecommended}
              options={[
                { value: NONE, label: t("decision.edit.noRecommendation") },
                ...options.map((o) => ({ value: o.id, label: o.label })),
              ]}
              className="max-sm:[&>select]:h-10 sm:max-w-xs"
            />
          </FormField>
          {recommended && (
            <FormField label={t("decision.edit.reason")} htmlFor={`${id}-why`} error={errors.fields.recommendation}>
              <Textarea
                id={`${id}-why`}
                autoGrow
                rows={2}
                value={recommendation}
                onChange={(e) => setRecommendation(e.target.value)}
                placeholder={t("decision.new.reason")}
                className="max-sm:text-base"
              />
            </FormField>
          )}
        </>
      )}
    </FormDialog>
  );
}
