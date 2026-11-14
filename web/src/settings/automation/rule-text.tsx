// A rule read out as a sentence: "When a task changes in SVA and moves to
// Done, then notify @aram."

import type { ReactNode } from "react";
import { t, tMaybe } from "@/lib/i18n";
import { useCollection } from "@/lib/selectors";
import type { Rule, Webhook } from "@/settings/automation/data";
import { eventName } from "@/settings/automation/event-picker";

const Strong = ({ children }: { children: ReactNode }) => <span className="font-medium text-ink">{children}</span>;

export function RuleSentence({ rule, hooks }: { rule: Rule; hooks: Webhook[] }) {
  const projects = useCollection("projects");
  const members = useCollection("members");
  const m = rule.match ?? {};
  const a = rule.action;

  const types = m.event_types ?? [];
  const what = types.length === 0 ? t("auto.rule.anything") : types.map(eventName).join(t("auto.rule.or"));
  const project = m.project_id ? projects[m.project_id] : undefined;
  const actor = m.actor_id ? members[m.actor_id] : undefined;
  const target = a?.user_id ? members[a.user_id] : undefined;
  const who = target ? `@${target.handle}` : t("common.someone");
  const hook = a?.webhook_id ? hooks.find((h) => h.id === a.webhook_id) : undefined;

  return (
    <span className="text-sm text-ink-2">
      {t("auto.rule.when")} <Strong>{what}</Strong>
      {project && <> {t("auto.rule.inProject", { key: project.key })}</>}
      {actor ? <> {t("auto.rule.byMember", { handle: actor.handle })}</> : m.actor_kind ? <> {tMaybe(`auto.rule.by.${m.actor_kind}`)}</> : null}
      {m.to_category && <> {t("auto.rule.toCategory", { category: tMaybe(`category.${m.to_category}`) })}</>}
      {m.outcome && <> {t("auto.rule.withOutcome", { outcome: tMaybe(`auto.outcome.${m.outcome}`) })}</>}
      {t("auto.rule.then")}{" "}
      <Strong>
        {a?.kind === "webhook"
          ? t("auto.rule.do.webhook", { name: hook?.name ?? t("auto.rule.goneWebhook") })
          : a
            ? tMaybe(`auto.rule.do.${a.kind}`).replace("{who}", who)
            : t("auto.rule.nothing")}
      </Strong>
      {a?.message && a.kind !== "webhook" && a.kind !== "assign" && <>: “{a.message}”</>}
      .
    </span>
  );
}
