// What was decided lately, and the standing preferences that came of it.

import { Pin } from "lucide-react";
import { Link } from "react-router";
import { t, tMaybe } from "@/lib/i18n";
import { useCollection, useSlug } from "@/lib/selectors";
import { exact } from "@/lib/time";
import { parseWhen } from "@/insights/lib/format";
import { useMembersByHandle } from "@/insights/lib/members";
import type { DecisionView } from "@/insights/lib/types";
import type { Preference } from "@/lib/types-plan";
import { Panel, PanelEmpty } from "@/insights/ui/panel";
import { useTaskLink } from "@/lib/task-link";
import { Avatar } from "@/ui/avatar";
import { Ago } from "@/ui/ago";

/** The answer in a few words: the option picked and how, or that it went back. */
function answerOf(d: DecisionView): string {
  const how = d.outcome ? tMaybe(`decision.outcome.${d.outcome}`, d.outcome) : "";
  if (d.picked_label) return t("dash.decisions.picked", { label: d.picked_label, how });
  return how || (d.state === "sent_back" ? t("decision.state.sentBack") : "");
}

function Row({ decision }: { decision: DecisionView }) {
  const link = useTaskLink({ key: decision.task ?? "" });
  const by = useMembersByHandle()(decision.decided_by);
  const at = parseWhen(decision.decided_at);
  return (
    <li className="relative flex gap-2 border-b border-line/70 px-4 py-2 text-sm hover:bg-hover">
      <div className="min-w-0 flex-1">
        <Link
          {...link}
          className="block truncate font-medium outline-none after:absolute after:inset-0 after:content-['']"
        >
          {decision.question}
        </Link>
        <p className="truncate text-ink-2">{answerOf(decision)}</p>
        {decision.note && <p className="line-clamp-2 text-xs text-ink-3">{decision.note}</p>}
      </div>
      <div className="flex shrink-0 items-start gap-2 pt-0.5">
        <span className="flex gap-2 text-xs text-ink-3 tnum">
          <span>{decision.task}</span>
          {at > 0 && (
            <span title={exact(at)}>
              <Ago ms={at} />
            </span>
          )}
        </span>
        <Avatar member={by} size="sm" />
      </div>
    </li>
  );
}

function PreferenceRow({ preference }: { preference: Preference }) {
  const project = useCollection("projects")[preference.project_id ?? ""];
  return (
    <li className="flex gap-2 border-b border-line/70 px-4 py-1.5 text-sm">
      <Pin className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="min-w-0 flex-1">{preference.body}</span>
      <span className="shrink-0 text-xs text-ink-3 tnum">{project ? project.key : t("dash.prefs.everywhere")}</span>
    </li>
  );
}

interface Props {
  decisions: DecisionView[];
  preferences: Preference[];
  className?: string;
}

export function DecisionsPanel({ decisions, preferences, className }: Props) {
  const slug = useSlug();
  return (
    <Panel
      title={t("dash.decisions")}
      action={
        <Link
          to={`/${slug}/decisions`}
          className="text-xs font-medium text-accent-text underline-offset-2 hover:underline"
        >
          {t("dash.decisions.all")}
        </Link>
      }
      className={className}
      flush
    >
      {decisions.length === 0 ? (
        <PanelEmpty>{t("dash.decisions.empty")}</PanelEmpty>
      ) : (
        <ul className="border-t border-line/70">
          {decisions.map((d) => (
            <Row key={d.id} decision={d} />
          ))}
        </ul>
      )}
      {preferences.length > 0 && (
        <>
          <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-ink-2">{t("dash.prefs")}</h3>
          <ul className="border-t border-line/70">
            {preferences.map((p) => (
              <PreferenceRow key={p.id} preference={p} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
