import { useState } from "react";
import { ChevronRight, Plus, Radio } from "lucide-react";
import { useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { useMembers } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { CreateAgentDialog } from "@/settings/agents/agent-create";
import { type AgentMember, type AgentState, useAgentStates, useResponsible } from "@/settings/agents/data";
import { useIsAdmin, useSettingsBase } from "@/settings/base";
import { Fact, When } from "@/settings/ui/bits";
import { EmptyRow, Page, Rows } from "@/settings/ui/layout";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Tooltip } from "@/ui/tooltip";

/** Whether a program is waiting for this agent's work, as a small mark with its meaning on hover. */
export function ListeningMark({ on, withText }: { on: boolean; withText?: boolean }) {
  return (
    <Tooltip label={on ? t("agents.listeningHint") : t("agents.notListeningHint")}>
      <span className={cx("inline-flex items-center gap-1 text-xs whitespace-nowrap", on ? "text-ok" : "text-ink-3")}>
        <Radio className="size-3.5" aria-hidden />
        <span className={withText ? "" : "max-lg:sr-only"}>{on ? t("agents.listening") : t("agents.notListening")}</span>
      </span>
    </Tooltip>
  );
}

export function StateBadge({ state }: { state: AgentState | undefined }) {
  if (!state) return null;
  const tone = state.state === "working" ? "accent" : state.state === "has_work" ? "wait" : "neutral";
  return (
    <Badge tone={tone}>
      {tMaybe(`agents.state.${state.state}`, state.state)}
      {state.task && state.state === "working" && <span className="font-normal opacity-80">{t("agents.on", { task: state.task })}</span>}
    </Badge>
  );
}

/** Every agent in the workspace: what it is, what it is doing, and whether anything is listening for it. */
export function AgentsPage() {
  const base = useSettingsBase();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const agents = useMembers().filter((m) => m.kind === "agent") as AgentMember[];
  const members = useStore((s) => s.c.members);
  const states = useAgentStates();
  const responsible = useResponsible();
  const [creating, setCreating] = useState(false);

  return (
    <Page
      title={t("agents.title")}
      lead={t("agents.lead")}
      back={base}
      wide
      actions={
        admin && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden />
            {t("agents.new")}
          </Button>
        )
      }
    >
      {agents.length === 0 ? (
        <EmptyRow>
          <p className="font-medium text-ink">{t("agents.none")}</p>
          <p className="mt-1">{t("agents.noneHint")}</p>
        </EmptyRow>
      ) : (
        <Rows>
          {agents.map((a) => {
            const state = states.data?.[a.user_id];
            const person = members[a.responsible_id ?? responsible.data?.[a.user_id] ?? ""];
            return (
              <button
                key={a.user_id}
                type="button"
                onClick={() => navigate(`${base}/agents/${a.handle}`)}
                aria-label={t("agents.open", { name: a.name })}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover/60"
              >
                <Avatar member={a} size="lg" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    {a.role === "admin" && <Badge>{t("role.admin")}</Badge>}
                    {a.suspended_at && <Badge tone="wait">{t("agents.suspended")}</Badge>}
                    <StateBadge state={state} />
                  </span>
                  <span className="block truncate text-xs text-ink-3">
                    @{a.handle}
                    {a.title ? ` · ${a.title}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-ink-2 max-md:hidden">
                  {person && <Fact label={t("agents.responsible")}>{person.name}</Fact>}
                  <span className="flex items-center gap-1">
                    {a.last_action && <span className="max-w-44 truncate text-ink-3">{a.last_action}</span>}
                    <When ms={a.last_seen_at} />
                  </span>
                </span>
                {state && <ListeningMark on={state.listening} />}
                <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
              </button>
            );
          })}
        </Rows>
      )}
      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(handle) => {
            setCreating(false);
            navigate(`${base}/agents/${handle}`);
          }}
        />
      )}
    </Page>
  );
}
