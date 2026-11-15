import type { Changes } from "@/lib/changes.gen";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { useMembers, useProjects } from "@/lib/selectors";
import { memberChoiceLabel } from "@/settings/agents/data";
import { useListening } from "@/lib/listening";
import { Input } from "@/ui/input";
import { FormField, NativeSelect, refuse, SwitchRow, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { change, randomSecret } from "@/settings/automation/data";
import type { Webhook } from "@/lib/types-automation";
import { isWebAddress } from "@/lib/url";
import { EventPicker } from "@/settings/automation/event-picker";

type Scope = "all" | "project" | "member";

interface Props {
  /** The webhook to edit; none to create one. */
  hook?: Webhook;
  onClose: () => void;
  /** Called after the server took it. A new webhook comes with the secret to show once. */
  onSaved: (secret?: { name: string; value: string }) => void;
}

export function WebhookForm({ hook, onClose, onSaved }: Props) {
  const projects = useProjects();
  const members = useMembers();
  const listening = useListening();
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState(hook?.url ?? "");
  const [events, setEvents] = useState<string[]>(hook?.event_types ?? []);
  const [scope, setScope] = useState<Scope>(hook?.user_id ? "member" : hook?.project_id ? "project" : "all");
  const [projectId, setProjectId] = useState(hook?.project_id ?? "");
  const [memberId, setMemberId] = useState(hook?.user_id ?? "");
  const [active, setActive] = useState(hook?.active ?? true);
  const errors = useFieldErrors(["name", "url", "project", "for", "event_types"]);

  // Agents first: waking an agent is what "for" is for.
  const inboxes = [...members].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1));

  async function submit() {
    if (!isWebAddress(url)) refuse("url", t("auto.hook.urlInvalid"));
    if (scope === "project" && !projectId) refuse("project", t("auto.hook.projectMissing"));
    if (scope === "member" && !memberId) refuse("for", t("auto.hook.memberMissing"));
    if (hook) {
      await change("webhook.update", {
        id: hook.id,
        name: name.trim() || null,
        url: url.trim(),
        // An inbox webhook gets what lands in the inbox, whatever its type.
        event_types: scope === "member" ? [] : events,
        project: scope === "project" ? projectId : null,
        for: scope === "member" ? memberId : null,
        active,
      });
      onSaved();
    } else {
      const secret = randomSecret();
      const args: Changes["webhook.create"] = { id: newId(), name: name.trim(), url: url.trim(), secret, active };
      if (scope === "member") args.for = memberId;
      else {
        args.event_types = events;
        if (scope === "project") args.project = projectId;
      }
      await change("webhook.create", args);
      onSaved({ name: name.trim() || new URL(url.trim()).host, value: secret });
    }
  }

  const scopeChoices = [
    { value: "all", label: t("auto.hook.scope.all") },
    { value: "project", label: t("auto.hook.scope.project") },
    { value: "member", label: t("auto.hook.scope.member") },
  ];

  return (
    <FormDialog
      title={hook ? t("auto.hook.edit") : t("auto.hook.new")}
      description={hook ? undefined : t("auto.hook.newLead")}
      submit={hook ? t("common.save") : t("auto.hook.create")}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <FormField label={t("auto.hook.url")} htmlFor="wh-url" error={errors.fields.url} hint={t("auto.hook.urlHint")}>
        <Input
          id="wh-url"
          type="url"
          inputMode="url"
          autoFocus
          required
          placeholder="https://example.com/hooks/quadit"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            errors.set("url", "");
          }}
        />
      </FormField>
      <FormField label={t("s.name")} htmlFor="wh-name" error={errors.fields.name} hint={t("auto.hook.nameHint")}>
        <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>

      <FormField
        label={t("auto.hook.scope")}
        htmlFor="wh-scope"
        hint={scope === "member" ? t("auto.hook.scope.memberHint") : undefined}
      >
        <NativeSelect id="wh-scope" value={scope} onChange={(v) => setScope(v as Scope)} options={scopeChoices} />
      </FormField>
      {scope === "project" && (
        <FormField label={t("auto.project")} htmlFor="wh-project" error={errors.fields.project}>
          <NativeSelect
            id="wh-project"
            value={projectId}
            onChange={(v) => {
              setProjectId(v);
              errors.set("project", "");
            }}
            options={[
              { value: "", label: t("auto.pickProject") },
              ...projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
            ]}
          />
        </FormField>
      )}
      {scope === "member" && (
        <FormField label={t("auto.hook.for")} htmlFor="wh-for" error={errors.fields.for}>
          <NativeSelect
            id="wh-for"
            value={memberId}
            onChange={(v) => {
              setMemberId(v);
              errors.set("for", "");
            }}
            options={[
              { value: "", label: t("auto.pickMember") },
              ...inboxes.map((m) => ({ value: m.user_id, label: memberChoiceLabel(m, listening(m)) })),
            ]}
          />
        </FormField>
      )}
      {scope !== "member" && (
        <FormField label={t("auto.events")} error={errors.fields.event_types}>
          <EventPicker value={events} onChange={setEvents} />
        </FormField>
      )}

      <SwitchRow title={t("auto.active")} hint={t("auto.hook.activeHint")} checked={active} onChange={setActive} />
    </FormDialog>
  );
}
