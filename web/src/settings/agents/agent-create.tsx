import type { Changes } from "@/lib/changes.gen";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { mutate } from "@/lib/mutate";
import { getRow, useMe } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import {
  AGENT_FIELDS,
  type AgentDraft,
  AgentLimitFields,
  AgentProfileFields,
  draftOf,
  limitsOf,
} from "@/settings/agents/agent-form";
import { refuse, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";

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
  const set = (patch: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit() {
    if (!draft.name.trim()) refuse("name", t("s.required"));
    const limits = limitsOf(draft, true);
    if ("bad" in limits) refuse(limits.bad, t("agent.budgetBad"));
    const args: Changes["agent.create"] = {
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
    await mutate({ type: "agent.create", args }, undefined, { quiet: true });
    toast.info(t("agent.created", { name: draft.name.trim() }));
    onCreated(getRow("members", id)?.handle ?? draft.handle.trim());
  }

  return (
    <FormDialog title={t("agents.new")} submit={t("agent.create")} errors={errors} onSubmit={submit} onClose={onClose}>
      <AgentProfileFields draft={draft} set={set} errors={errors} creating seed={id} />
      <div className="mt-1.5 border-t border-line pt-4">
        <h3 className="text-sm font-semibold">{t("agent.limits")}</h3>
        <p className="mb-3 text-sm text-ink-2">{t("agent.limitsLead")}</p>
        <AgentLimitFields draft={draft} set={set} errors={errors} creating />
      </div>
    </FormDialog>
  );
}
