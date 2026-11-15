import { type FormEvent, useState } from "react";
import { t, tMaybe } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { useMembers, useProjects } from "@/lib/selectors";
import { CATEGORIES } from "@/lib/types";
import { memberChoiceLabel, useListening } from "@/settings/agents/data";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { FormAlert, FormField, NativeSelect, SwitchRow, useFieldErrors, useSubmit } from "@/settings/ui/form";
import {
  ACTION_KINDS,
  type ActionKind,
  change,
  OUTCOMES,
  type Rule,
  type RuleAction,
  type RuleMatch,
  typeMatches,
  type Webhook,
} from "@/settings/automation/data";
import { EventPicker } from "@/settings/automation/event-picker";

interface Props {
  /** The rule to edit; none to create one. */
  rule?: Rule;
  /** The workspace's webhooks, for "call a webhook". */
  hooks: Webhook[];
  onClose: () => void;
  onSaved: () => void;
}

const FIELDS = [
  "name",
  "project",
  "project_id",
  "actor_kind",
  "outcome",
  "to_category",
  "kind",
  "user_id",
  "webhook_id",
];

export function RuleForm({ rule, hooks, onClose, onSaved }: Props) {
  const projects = useProjects();
  const members = useMembers();
  const listening = useListening();
  const m = rule?.match ?? {};
  const [name, setName] = useState(rule?.name ?? "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [events, setEvents] = useState<string[]>(m.event_types ?? []);
  const [projectId, setProjectId] = useState(m.project_id ?? "");
  const [actorKind, setActorKind] = useState<string>(m.actor_kind ?? "");
  const [outcome, setOutcome] = useState<string>(m.outcome ?? "");
  const [toCategory, setToCategory] = useState<string>(m.to_category ?? "");
  const [kind, setKind] = useState<ActionKind>(rule?.action?.kind ?? "notify");
  const [userId, setUserId] = useState(rule?.action?.user_id ?? "");
  const [webhookId, setWebhookId] = useState(rule?.action?.webhook_id ?? "");
  const [message, setMessage] = useState(rule?.action?.message ?? "");
  const errors = useFieldErrors(FIELDS);
  const { busy, run } = useSubmit(errors);

  // These two narrow one kind of event each; offer them only when that event can match.
  const canOutcome = typeMatches(events, "decision.picked");
  const canCategory = typeMatches(events, "task.updated");

  async function submit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!name.trim()) return errors.set("name", t("s.required"));
    if (kind === "webhook" && !webhookId) return errors.set("webhook_id", t("auto.rule.webhookMissing"));
    if (kind !== "webhook" && !userId) return errors.set("user_id", t("auto.rule.memberMissing"));

    const match: RuleMatch = {};
    if (events.length) match.event_types = events;
    if (projectId) match.project_id = projectId;
    // A member or label narrowing set through the API is kept as it is.
    if (m.actor_id) match.actor_id = m.actor_id;
    if (m.label_id) match.label_id = m.label_id;
    if (actorKind) match.actor_kind = actorKind as RuleMatch["actor_kind"];
    if (outcome && canOutcome) match.outcome = outcome as RuleMatch["outcome"];
    if (toCategory && canCategory) match.to_category = toCategory as RuleMatch["to_category"];
    const action: RuleAction = kind === "webhook" ? { kind, webhook_id: webhookId } : { kind, user_id: userId };
    if (message.trim() && (kind === "notify" || kind === "wait_on")) action.message = message.trim();

    await run(async () => {
      await change(rule ? "rule.update" : "rule.create", {
        id: rule?.id ?? newId(),
        name: name.trim(),
        active,
        match,
        action,
      });
      onSaved();
    });
  }

  const any = { value: "", label: t("auto.any") };
  const memberChoices = [
    { value: "", label: t("auto.pickMember") },
    ...members.map((mb) => ({ value: mb.user_id, label: memberChoiceLabel(mb, listening(mb)) })),
  ];

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={rule ? t("auto.rule.edit") : t("auto.rule.new")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" form="rule-form" disabled={busy}>
            {rule ? t("common.save") : t("auto.rule.create")}
          </Button>
        </>
      }
    >
      <form id="rule-form" onSubmit={submit} className="flex flex-col gap-3.5" noValidate>
        <FormField label={t("s.name")} htmlFor="rule-name" error={errors.fields.name}>
          <Input
            id="rule-name"
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              errors.set("name", "");
            }}
            placeholder={t("auto.rule.namePlaceholder")}
          />
        </FormField>

        <h3 className="mt-1 text-xs font-semibold tracking-wide text-ink-3 uppercase">{t("auto.rule.whenTitle")}</h3>
        <FormField label={t("auto.events")}>
          <EventPicker value={events} onChange={setEvents} />
        </FormField>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <FormField
            label={t("auto.project")}
            htmlFor="rule-project"
            error={errors.fields.project_id ?? errors.fields.project}
          >
            <NativeSelect
              id="rule-project"
              value={projectId}
              onChange={setProjectId}
              options={[
                { value: "", label: t("s.everyProject") },
                ...projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
              ]}
            />
          </FormField>
          <FormField label={t("auto.rule.actorKind")} htmlFor="rule-actor" error={errors.fields.actor_kind}>
            <NativeSelect
              id="rule-actor"
              value={actorKind}
              onChange={setActorKind}
              options={[
                { value: "", label: t("s.anyone") },
                { value: "person", label: t("auto.rule.actor.person") },
                { value: "agent", label: t("auto.rule.actor.agent") },
              ]}
            />
          </FormField>
          {canCategory && (
            <FormField
              label={t("auto.rule.toCategoryLabel")}
              htmlFor="rule-cat"
              error={errors.fields.to_category}
              hint={t("auto.rule.toCategoryHint")}
            >
              <NativeSelect
                id="rule-cat"
                value={toCategory}
                onChange={setToCategory}
                options={[any, ...CATEGORIES.map((c) => ({ value: c, label: tMaybe(`category.${c}`) }))]}
              />
            </FormField>
          )}
          {canOutcome && (
            <FormField
              label={t("auto.rule.outcomeLabel")}
              htmlFor="rule-outcome"
              error={errors.fields.outcome}
              hint={t("auto.rule.outcomeHint")}
            >
              <NativeSelect
                id="rule-outcome"
                value={outcome}
                onChange={setOutcome}
                options={[any, ...OUTCOMES.map((o) => ({ value: o, label: tMaybe(`auto.outcome.${o}`) }))]}
              />
            </FormField>
          )}
        </div>

        <h3 className="mt-1 text-xs font-semibold tracking-wide text-ink-3 uppercase">{t("auto.rule.thenTitle")}</h3>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <FormField label={t("auto.rule.action")} htmlFor="rule-kind" error={errors.fields.kind}>
            <NativeSelect
              id="rule-kind"
              value={kind}
              onChange={(v) => setKind(v as ActionKind)}
              options={ACTION_KINDS.map((k) => ({ value: k, label: tMaybe(`auto.rule.kind.${k}`) }))}
            />
          </FormField>
          {kind === "webhook" ? (
            <FormField
              label={t("auto.rule.webhook")}
              htmlFor="rule-hook"
              error={errors.fields.webhook_id}
              hint={hooks.length === 0 ? t("auto.rule.noWebhooks") : undefined}
            >
              <NativeSelect
                id="rule-hook"
                value={webhookId}
                onChange={(v) => {
                  setWebhookId(v);
                  errors.set("webhook_id", "");
                }}
                options={[
                  { value: "", label: t("auto.pickWebhook") },
                  ...hooks.map((h) => ({ value: h.id, label: h.name })),
                ]}
              />
            </FormField>
          ) : (
            <FormField label={tMaybe(`auto.rule.who.${kind}`)} htmlFor="rule-user" error={errors.fields.user_id}>
              <NativeSelect
                id="rule-user"
                value={userId}
                onChange={(v) => {
                  setUserId(v);
                  errors.set("user_id", "");
                }}
                options={memberChoices}
              />
            </FormField>
          )}
        </div>
        {(kind === "notify" || kind === "wait_on") && (
          <FormField label={t("auto.rule.message")} htmlFor="rule-msg" hint={t("auto.rule.messageHint")}>
            <Input id="rule-msg" value={message} onChange={(e) => setMessage(e.target.value)} />
          </FormField>
        )}
        {(kind === "assign" || kind === "wait_on") && <p className="text-xs text-ink-3">{t("auto.rule.taskOnly")}</p>}

        <SwitchRow title={t("auto.active")} hint={t("auto.rule.activeHint")} checked={active} onChange={setActive} />
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}
