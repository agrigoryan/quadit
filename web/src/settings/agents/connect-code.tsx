// An agent's connect code: a person makes one for the tool the agent runs
// in and says the line it gives in that tool; the agent gives the code back
// with its own login, and the page sees it used. So connecting is proven
// without the desktop app. The line names the workspace: the tool may work
// in several, and the code goes to this one's server alone.

import { type FormEvent, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
import { readError } from "@/data/query";
import { useSlug, useWorkspaceName } from "@/data/selectors";
import { type AgentMember, connectCodeKey, makeConnectCode, readConnectCode } from "@/settings/agents/data";
import { FormAlert, FormField, Note } from "@/ui/form";
import { Card, EmptyRow, Section } from "@/ui/page-layout";
import { CopyField } from "@/ui/reveal-dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

/** How often a code shown on the page is asked about until it is used. */
const ASK_MS = 3_000;

export function AgentConnectCode({ agent, canMake }: { agent: AgentMember; canMake: boolean }) {
  const slug = useSlug();
  const workspace = useWorkspaceName();
  // Connect names an agent after its tool, so its name is the likely answer.
  const [tool, setTool] = useState(agent.name);
  const make = useMutation({ mutationFn: (forTool: string) => makeConnectCode(slug, agent.user_id, forTool) });
  const made = make.data;
  const state = useQuery({
    queryKey: connectCodeKey(slug, made?.id ?? ""),
    queryFn: ({ signal }) => readConnectCode(slug, made?.id ?? "", signal),
    enabled: !!made,
    refetchInterval: (query) => (query.state.data?.used || query.state.data?.expired ? false : ASK_MS),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (tool.trim()) make.mutate(tool.trim());
  }

  return (
    <Section title={t("connectCode.title")} lead={t("connectCode.lead")}>
      {!canMake ? (
        <EmptyRow>{t("connectCode.adminsOnly")}</EmptyRow>
      ) : (
        <Card className="flex flex-col gap-4">
          <form onSubmit={submit} className="flex flex-col items-start gap-2">
            <FormField label={t("connectCode.tool")} htmlFor="connect-tool" hint={t("connectCode.toolHint")}>
              <Input id="connect-tool" value={tool} onChange={(e) => setTool(e.target.value)} className="w-56" />
            </FormField>
            <Button type="submit" disabled={make.isPending || !tool.trim()}>
              {made ? t("connectCode.again") : t("connectCode.make")}
            </Button>
          </form>
          {make.error && <FormAlert>{readError(make.error)}</FormAlert>}
          {made && (
            <div className="flex flex-col gap-2">
              <p className="text-sm">{t("connectCode.say", { tool: made.tool })}</p>
              <CopyField value={t("connectCode.line", { code: made.code, workspace })} />
              <output className="block">
                {state.data?.used ? (
                  <Note tone="ok">{t("connectCode.used", { tool: made.tool })}</Note>
                ) : state.data?.expired ? (
                  <Note tone="wait">{t("connectCode.expired")}</Note>
                ) : (
                  <p className="text-xs text-ink-3">{t("connectCode.waiting", { tool: made.tool })}</p>
                )}
              </output>
            </div>
          )}
        </Card>
      )}
    </Section>
  );
}
