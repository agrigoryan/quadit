import type { Changes } from "@/lib/changes.gen";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { t } from "@/lib/i18n";
import { type ChangeSpec, mutate, send } from "@/lib/mutate";
import { useMembers } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import {
  AGENT_FIELDS,
  type AgentDraft,
  AgentLimitFields,
  AgentProfileFields,
  draftOf,
  limitsOf,
} from "@/settings/agents/agent-form";
import { ListeningMark, StateBadge } from "@/settings/agents/agents";
import { type AgentMember } from "@/settings/agents/data";
import { useAgentStates } from "@/lib/listening";
import { isFinishedHelper, useHelperLabel } from "@/settings/agents/helper-agents";
import { AgentTokens } from "@/settings/agents/tokens";
import { useIsAdmin, useSettingsBase } from "@/settings/base";
import { Fact } from "@/ui/fact";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/settings-dialogs";
import { FormAlert, FormFoot, useFieldErrors, useSubmit } from "@/ui/form";
import { Card, Page, Section } from "@/ui/settings-layout";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

/** One agent: what it is, what it may do, its tokens, and the way to stop it. */
export function AgentPage() {
  const { handle = "" } = useParams();
  const base = useSettingsBase();
  const agent = useMembers().find((m) => m.kind === "agent" && m.handle === handle);
  if (!agent) {
    return (
      <EmptyState
        title={t("agent.notFound")}
        action={
          <Link to={`${base}/agents`} className="text-sm font-medium text-accent-text hover:underline">
            {t("agent.back")}
          </Link>
        }
      />
    );
  }
  return <AgentBody key={agent.user_id} agent={agent} />;
}

function AgentBody({ agent }: { agent: AgentMember }) {
  const base = useSettingsBase();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const states = useAgentStates();
  const knownResponsible = agent.responsible_id ?? "";
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(agent, knownResponsible));
  const [ask, setAsk] = useState<"suspend" | "remove" | null>(null);
  const errors = useFieldErrors(AGENT_FIELDS);
  const { busy, run } = useSubmit(errors);
  const set = (patch: Partial<AgentDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const state = states.data?.[agent.user_id];
  const helper = useHelperLabel()(agent);

  // Someone else changed who is responsible while this page was open: follow, unless the person already chose here.
  const [seenResponsible, setSeenResponsible] = useState(knownResponsible);
  if (seenResponsible !== knownResponsible) {
    setSeenResponsible(knownResponsible);
    if (draft.responsible === seenResponsible) setDraft((d) => ({ ...d, responsible: knownResponsible }));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    if (!draft.name.trim()) return errors.set("name", t("s.required"));
    const limits = limitsOf(draft);
    if ("bad" in limits) return errors.set(limits.bad, t("agent.budgetBad"));
    const args: Changes["agent.update"] = {
      id: agent.user_id,
      name: draft.name.trim(),
      description: draft.description.trim(),
      avatar: draft.avatar,
      scope: limits.scope,
      budget: limits.budget,
    };
    if (draft.responsible && draft.responsible !== knownResponsible) args.responsible = draft.responsible;
    const changes: ChangeSpec[] = [{ type: "agent.update", args }];
    if (draft.role !== agent.role)
      changes.push({ type: "member.update", args: { id: agent.user_id, role: draft.role } });
    await run(async () => {
      await mutate(changes, undefined, { quiet: true });
      toast.info(t("s.saved"));
    });
  }

  const resume = () =>
    send({ type: "member.update", args: { id: agent.user_id, suspended: false } }, (tx) =>
      tx.patch("members", agent.user_id, { suspended_at: null }),
    );

  return (
    <Page
      title={agent.name}
      back={`${base}/agents`}
      backLabel={t("agent.back")}
      lead={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>@{agent.handle}</span>
          <StateBadge state={state} />
          {state && <ListeningMark on={state.listening} withText />}
          {isFinishedHelper(agent) ? (
            <Badge>{t("agents.finished")}</Badge>
          ) : agent.suspended_at ? (
            <Badge tone="wait">{t("agents.suspended")}</Badge>
          ) : null}
          {helper && <span className="text-ink-2">{helper}</span>}
        </span>
      }
      actions={<Avatar member={agent} size="lg" />}
    >
      <Section title={t("agent.status")}>
        <Card className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
          <Fact label={t("agent.seen")}>
            <When ms={agent.last_seen_at} />
          </Fact>
          {agent.last_action && <Fact label={t("agents.lastAction")}>{agent.last_action}</Fact>}
          {state?.doing && <Fact label={state.task ?? ""}>{state.doing}</Fact>}
          {state?.cost_week && <Fact label={t("agent.budgetMoney")}>{state.cost_week}</Fact>}
          {!!state?.minutes_week && <Fact label={t("agent.budgetMinutes")}>{state.minutes_week}</Fact>}
        </Card>
      </Section>

      <AgentTokens agent={agent} canEdit={admin} />

      <form onSubmit={save} className="flex flex-col gap-8">
        <Section title={t("agent.profile")}>
          <Card>
            <AgentProfileFields draft={draft} set={set} errors={errors} disabled={!admin} seed={agent.user_id} />
          </Card>
        </Section>
        <Section title={t("agent.limits")} lead={t("agent.limitsLead")}>
          <Card>
            <AgentLimitFields draft={draft} set={set} errors={errors} disabled={!admin} />
          </Card>
        </Section>
        {admin && (
          <div className="-mt-4 flex flex-col gap-2">
            <FormAlert>{errors.form}</FormAlert>
            <FormFoot>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? t("s.saving") : t("agent.save")}
              </Button>
            </FormFoot>
          </div>
        )}
      </form>

      {admin && (
        <Section title={t("agent.danger")}>
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-sm text-ink-2">{t("agent.suspendLead")}</p>
              {agent.suspended_at ? (
                <Button onClick={resume}>{t("agent.resume")}</Button>
              ) : (
                <Button onClick={() => setAsk("suspend")}>{t("agent.suspend")}</Button>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="max-w-md text-sm text-ink-2">{t("agent.removeLead")}</p>
              <Button variant="danger-quiet" onClick={() => setAsk("remove")}>
                {t("agent.remove")}
              </Button>
            </div>
          </Card>
        </Section>
      )}

      <ConfirmDialog
        open={ask === "suspend"}
        onOpenChange={(open) => !open && setAsk(null)}
        title={t("agent.suspend.title", { name: agent.name })}
        body={t("agent.suspendLead")}
        confirm={t("members.suspend")}
        onConfirm={() =>
          mutate({ type: "member.update", args: { id: agent.user_id, suspended: true } }, undefined, { quiet: true })
        }
      />
      <ConfirmDialog
        open={ask === "remove"}
        onOpenChange={(open) => !open && setAsk(null)}
        title={t("agent.remove.title", { name: agent.name })}
        body={t("agent.removeLead")}
        confirm={t("s.remove")}
        onConfirm={async () => {
          await mutate({ type: "member.remove", args: { id: agent.user_id } }, undefined, { quiet: true });
          void navigate(`${base}/agents`);
        }}
      />
    </Page>
  );
}
