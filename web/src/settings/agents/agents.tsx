import { useState } from "react";
import { ChevronRight, CornerDownRight, Plus, Radio } from "lucide-react";
import { useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t, tMaybe } from "@/lib/i18n";
import { useCan } from "@/data/access";
import { useLookupEvenIfGone, useMembers } from "@/data/selectors";
import { CreateAgentDialog } from "@/settings/agents/agent-create";
import { type AgentMember } from "@/settings/agents/data";
import { type AgentState, useAgentStates } from "@/data/listening";
import { isFinishedHelper, placeHelpers, useHelperLabel } from "@/settings/agents/helper-agents";
import { useSettingsBase } from "@/settings/base";
import { Fact } from "@/ui/fact";
import { When } from "@/ui/when";
import { Checkbox } from "@/ui/form";
import { EmptyRow, Page, Rows } from "@/ui/page-layout";
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
        <span className={withText ? "" : "max-lg:sr-only"}>
          {on ? t("agents.listening") : t("agents.notListening")}
        </span>
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
      {state.task && state.state === "working" && (
        <span className="font-normal opacity-80">{t("agents.on", { task: state.task })}</span>
      )}
    </Badge>
  );
}

/** Every agent in the workspace: what it is, what it is doing, and whether anything is listening for it. */
export function AgentsPage() {
  const base = useSettingsBase();
  const admin = useCan().administer;
  const navigate = useNavigate();
  const agents = useMembers().filter((m) => m.kind === "agent") as AgentMember[];
  // Names of who answers for an agent and who made a helper, a removed one included.
  const members = useLookupEvenIfGone("members");
  const states = useAgentStates();
  const [creating, setCreating] = useState(false);
  const [showFinished, setShowFinished] = useState(false);
  const helperLabel = useHelperLabel();
  const placed = placeHelpers(agents, showFinished);
  const finished = agents.filter(isFinishedHelper).length;

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
        <>
          <Rows>
            {placed.rows.map(({ agent: a, depth }) => {
              const state = states.data?.[a.user_id];
              const person = members[a.responsible_id ?? ""];
              const helper = helperLabel(a);
              const done = isFinishedHelper(a);
              const maker = helper && depth === 0 ? members[a.delegated_by ?? ""] : undefined;
              return (
                <button
                  key={a.user_id}
                  type="button"
                  onClick={() => navigate(`${base}/agents/${a.handle}`)}
                  aria-label={t("agents.open", { name: a.name })}
                  className={cx(
                    "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover/60",
                    depth === 1 && "pl-8",
                    depth === 2 && "pl-14",
                  )}
                >
                  {depth > 0 && <CornerDownRight className="-mr-1 size-3.5 shrink-0 text-ink-3" aria-hidden />}
                  <Avatar member={a} size="lg" className={done ? "opacity-60" : undefined} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={cx("truncate text-sm font-medium", done && "text-ink-2")}>{a.name}</span>
                      {a.role === "admin" && <Badge>{t("role.admin")}</Badge>}
                      {done ? (
                        <Badge>{t("agents.finished")}</Badge>
                      ) : a.suspended_at ? (
                        <Badge tone="wait">{t("agents.suspended")}</Badge>
                      ) : null}
                      {!done && <StateBadge state={state} />}
                    </span>
                    <span className="block truncate text-xs text-ink-3">
                      {helper && <span className="text-ink-2">{helper} · </span>}
                      {maker && <span>{t("agents.helperOf", { name: maker.name })} · </span>}@{a.handle}
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
                  {state && !done && <ListeningMark on={state.listening} />}
                  <ChevronRight className="size-4 shrink-0 text-ink-3" aria-hidden />
                </button>
              );
            })}
          </Rows>
          {finished > 0 && (
            <div className="-mt-5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Checkbox checked={showFinished} onChange={setShowFinished}>
                {t("agents.showFinished")}
              </Checkbox>
              {!showFinished && (
                <span className="text-xs text-ink-3">{t("agents.finishedCount", { n: finished })}</span>
              )}
            </div>
          )}
        </>
      )}
      {creating && (
        <CreateAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(handle) => {
            setCreating(false);
            void navigate(`${base}/agents/${handle}`);
          }}
        />
      )}
    </Page>
  );
}
