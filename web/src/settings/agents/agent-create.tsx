import { type FormEvent, useState } from "react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { useMe } from "@/lib/selectors";
import { getState } from "@/lib/store";
import { toast } from "@/lib/toast";
import {
  AGENT_FIELDS,
  type AgentDraft,
  AgentLimitFields,
  AgentProfileFields,
  draftOf,
  limitsOf,
} from "@/settings/agents/agent-form";
import { FormAlert, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";

/** Makes an agent. Answers with its handle, so the page can open it to issue a token. */
export function CreateAgentDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (handle: string) => void;
}) {
  const me = useMe();
  // Whoever makes an agent answers for it unless they name someone else.
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(undefined, me.user_id));
  const [id] = useState(newId);
  const errors = useFieldErrors(AGENT_FIELDS);
  const { busy, run } = useSubmit(errors, { once: true });
  const set = (patch: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!draft.name.trim()) return errors.set("name", t("s.required"));
    const limits = limitsOf(draft, true);
    if ("bad" in limits) return errors.set(limits.bad, t("agent.budgetBad"));
    const args: Record<string, unknown> = {
      id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      role: draft.role,
    };
    if (draft.handle.trim()) args.handle = draft.handle.trim();
    if (draft.avatar) args.avatar = draft.avatar;
    if (draft.responsible) args.responsible = draft.responsible;
    if (limits.scope) args.scope = limits.scope;
    if (limits.budget) args.budget = limits.budget;
    await run(async () => {
      await mutate({ type: "agent.create", args }, undefined, { quiet: true });
      toast.info(t("agent.created", { name: draft.name.trim() }));
      onCreated(getState().c.members[id]?.handle ?? draft.handle.trim());
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("agents.new")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="agent-create" disabled={busy}>
            {t("agent.create")}
          </Button>
        </>
      }
    >
      <form id="agent-create" onSubmit={submit} className="flex flex-col gap-5">
        <AgentProfileFields draft={draft} set={set} errors={errors} creating seed={id} />
        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-semibold">{t("agent.limits")}</h3>
          <p className="mb-3 text-sm text-ink-2">{t("agent.limitsLead")}</p>
          <AgentLimitFields draft={draft} set={set} errors={errors} creating />
        </div>
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}
