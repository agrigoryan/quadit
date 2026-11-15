import { useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { t } from "@/lib/i18n";
import { useMembers } from "@/lib/selectors";
import type { Secret } from "@/types/core";
import { Avatar } from "@/ui/avatar";
import { Input } from "@/ui/input";
import { Tooltip } from "@/ui/tooltip";
import { useListening } from "@/lib/listening";
import { addHosts, setSecret, useSecrets, validName } from "@/settings/secrets/data";
import { HostInput } from "@/settings/secrets/host-input";
import { FormField, refuse, SwitchRow, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { MultiPick } from "@/settings/ui/multi-pick";

interface Props {
  /** The secret to change; none to make one. */
  secret?: Secret;
  onClose: () => void;
}

/** Makes a secret or changes one. Its value goes in and is never shown again. */
export function SecretForm({ secret, onClose }: Props) {
  const members = useMembers();
  const listening = useListening();
  const existing = useSecrets();
  const [name, setName] = useState(secret?.name ?? "");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [description, setDescription] = useState(secret?.description ?? "");
  const [hosts, setHosts] = useState<string[]>(secret?.hosts ?? []);
  const [hostDraft, setHostDraft] = useState("");
  const [agents, setAgents] = useState<string[]>(secret?.agents ?? []);
  const [env, setEnv] = useState(secret?.env ?? false);
  const errors = useFieldErrors(["name", "value", "hosts", "agents"]);

  // The workspace's agents, and anyone else the secret already names.
  const choices = useMemo(
    () =>
      members
        .filter((m) => m.kind === "agent" || agents.includes(m.user_id))
        .map((m) => ({
          id: m.user_id,
          label: m.name,
          icon: <Avatar member={m} size="xs" />,
          hint:
            listening(m) === undefined
              ? `@${m.handle}`
              : `@${m.handle} · ${listening(m) ? t("agents.choice.listening") : t("agents.choice.notListening")}`,
          keywords: m.handle,
        })),
    [members, agents, listening],
  );

  async function submit() {
    const trimmed = name.trim();
    if (!secret) {
      if (!validName(trimmed)) refuse("name", t("secrets.nameInvalid"));
      if (existing.some((s) => s.name === trimmed)) refuse("name", t("secrets.nameTaken", { name: trimmed }));
      if (!value) refuse("value", t("secrets.valueMissing"));
    }
    // A host typed and not yet entered counts.
    const all = addHosts(hosts, hostDraft);
    if ("bad" in all) refuse("hosts", t("secrets.hostInvalid", { host: all.bad }));
    setHosts(all.hosts);
    setHostDraft("");
    await setSecret({
      name: secret?.name ?? trimmed,
      value: value || undefined,
      description: description.trim(),
      hosts: all.hosts,
      agents,
      env,
    });
  }

  return (
    <FormDialog
      title={secret ? t("secrets.edit", { name: secret.name }) : t("secrets.new")}
      description={secret ? undefined : t("secrets.newLead")}
      submit={secret ? t("common.save") : t("secrets.create")}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
      <FormField
        label={t("secrets.name")}
        htmlFor="sec-name"
        error={errors.fields.name}
        hint={secret ? t("secrets.nameFixed") : t("secrets.nameHint")}
      >
        <Input
          id="sec-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            errors.set("name", "");
          }}
          disabled={!!secret}
          autoFocus={!secret}
          required
          placeholder="GITHUB_TOKEN"
          maxLength={64}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </FormField>

      <FormField
        label={t("secrets.value")}
        htmlFor="sec-value"
        error={errors.fields.value}
        hint={secret ? t("secrets.valueKeepHint") : undefined}
      >
        <div className="relative">
          <Input
            id="sec-value"
            type={shown ? "text" : "password"}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              errors.set("value", "");
            }}
            autoFocus={!!secret}
            placeholder={secret ? t("secrets.valueKeep") : undefined}
            // Not a sign-in: keep the browser from offering its own passwords here.
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            className={shown ? "pr-9 font-mono" : "pr-9"}
          />
          <Tooltip label={shown ? t("secrets.hide") : t("secrets.show")}>
            <button
              type="button"
              onClick={() => setShown(!shown)}
              aria-label={shown ? t("secrets.hide") : t("secrets.show")}
              aria-pressed={shown}
              className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-ink-3 hover:bg-hover hover:text-ink"
            >
              {shown ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
            </button>
          </Tooltip>
        </div>
      </FormField>

      <FormField label={t("secrets.description")} htmlFor="sec-description">
        <Input
          id="sec-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("secrets.descriptionPlaceholder")}
        />
      </FormField>

      <FormField
        label={t("secrets.hosts")}
        htmlFor="sec-hosts"
        error={errors.fields.hosts}
        hint={t("secrets.hostsHint")}
      >
        <HostInput
          id="sec-hosts"
          value={hosts}
          onChange={setHosts}
          draft={hostDraft}
          onDraft={setHostDraft}
          onError={(message) => errors.set("hosts", message)}
        />
      </FormField>

      <FormField label={t("secrets.agents")} error={errors.fields.agents} hint={t("secrets.agentsHint")}>
        <MultiPick
          items={choices}
          value={agents}
          onChange={(next) => {
            setAgents(next);
            errors.set("agents", "");
          }}
          addLabel={t("secrets.agentsAdd")}
          empty={t("secrets.everyMember")}
        />
      </FormField>

      <SwitchRow title={t("secrets.envSwitch")} hint={t("secrets.envHint")} checked={env} onChange={setEnv} />
    </FormDialog>
  );
}
