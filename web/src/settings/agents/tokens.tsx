import { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { api, workspacePath } from "@/lib/api";
import { t } from "@/lib/i18n";
import { dayAndMonth } from "@/lib/time";
import { useProjects, useSlug } from "@/lib/selectors";
import type { AgentMember, Token } from "@/settings/agents/data";
import { MultiPick } from "@/settings/ui/multi-pick";
import { Fact } from "@/ui/fact";
import { When } from "@/ui/when";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { RevealDialog } from "@/ui/reveal-dialog";
import { FormAlert, FormField, NativeSelect, SwitchRow } from "@/ui/form";
import { EmptyRow, Row, Rows, Section } from "@/ui/page-layout";
import { CreateTokenDialog, ScopeBadges, type TokenFieldsProps } from "@/settings/ui/tokens";
import { useLoad } from "@/lib/use-load";
import { ProjectGlyph } from "@/ui/project-glyph";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";

const EXPIRY = [0, 7, 30, 90, 365];

/** The tokens issued to one agent: make one (shown once), see when each was used, revoke. */
export function AgentTokens({ agent, canEdit }: { agent: AgentMember; canEdit: boolean }) {
  const slug = useSlug();
  // The server lists an agent's tokens for admins only; anyone else is told so rather than shown an empty list.
  const tokens = useLoad(
    () =>
      canEdit
        ? api
            .get<{ tokens: Token[] }>(workspacePath(slug, "/tokens"))
            .then((r) => r.tokens.filter((tk) => tk.user_id === agent.user_id))
        : Promise.resolve(null),
    [slug, agent.user_id, canEdit],
  );
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState("");
  const [revoke, setRevoke] = useState<Token | null>(null);
  const now = Date.now();

  return (
    <Section
      title={t("tokens.title")}
      lead={t("tokens.lead")}
      actions={
        canEdit && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden />
            {t("tokens.new")}
          </Button>
        )
      }
    >
      {tokens.error && <FormAlert>{tokens.error}</FormAlert>}
      {!canEdit && <EmptyRow>{t("tokens.adminsOnly")}</EmptyRow>}
      {tokens.data?.length === 0 && <EmptyRow>{t("tokens.none")}</EmptyRow>}
      {!!tokens.data?.length && (
        <Rows>
          {tokens.data.map((tk) => (
            <Row
              key={tk.id}
              lead={<KeyRound className="size-4 text-ink-3" aria-hidden />}
              title={tk.kind === "token" ? tk.name : `${tk.name || t("tokens.kind.oauth")}`}
              sub={<span className="font-mono">{tk.prefix}…</span>}
              meta={
                <>
                  <ScopeBadges
                    scopes={tk.scopes}
                    readOnly={t("tokens.scope.read")}
                    projects={(ids) => <Badge>{t("tokens.scope.projects", { n: ids.length })}</Badge>}
                  />
                  {tk.expires_at ? (
                    tk.expires_at < now ? (
                      <Badge tone="danger">{t("tokens.expired")}</Badge>
                    ) : (
                      <Fact label={t("tokens.expiresOn")} className="max-sm:hidden">
                        {dayAndMonth(tk.expires_at)}
                      </Fact>
                    )
                  ) : null}
                  <Fact label={t("tokens.used")} className="max-sm:hidden">
                    <When ms={tk.last_used_at} />
                  </Fact>
                </>
              }
              actions={
                canEdit && (
                  <Button variant="ghost" size="sm" onClick={() => setRevoke(tk)}>
                    {t("s.revoke")}
                  </Button>
                )
              }
            />
          ))}
        </Rows>
      )}

      {creating && (
        <CreateTokenDialog
          user={`@${agent.handle}`}
          title={t("tokens.new")}
          create={t("tokens.create")}
          compact
          days={0}
          fields={AgentTokenFields}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setSecret(created.token);
            void tokens.reload();
          }}
        />
      )}
      <TokenReveal token={secret} onClose={() => setSecret("")} />
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(open) => !open && setRevoke(null)}
        title={t("tokens.revoke.title", { name: revoke?.name ?? "" })}
        body={t("tokens.revoke.body")}
        confirm={t("s.revoke")}
        onConfirm={async () => {
          await api.del(workspacePath(slug, `/tokens/${revoke?.id}`));
          await tokens.reload();
        }}
      />
    </Section>
  );
}

/** Shows a new token the one time it can be shown, with the lines to paste into a terminal. */
function TokenReveal({ token, onClose }: { token: string; onClose: () => void }) {
  const url = location.origin;
  return (
    <RevealDialog
      open={!!token}
      onClose={onClose}
      title={t("tokens.created")}
      warning={t("tokens.once")}
      items={[
        { label: t("tokens.token"), value: token },
        { label: t("tokens.login"), value: `quadit login ${url} ${token}` },
        { label: t("tokens.env"), value: `export QUADIT_URL=${url}\nexport QUADIT_TOKEN=${token}`, multiline: true },
      ]}
    />
  );
}

/** The fields of a token for an agent: its name, read-only or not, its projects, when it expires. */
function AgentTokenFields({
  name,
  setName,
  readOnly,
  setReadOnly,
  projects: picked,
  setProjects: setPicked,
  days,
  setDays,
  errors,
}: TokenFieldsProps) {
  const projects = useProjects();

  return (
    <>
      <FormField label={t("tokens.name")} htmlFor="token-name" hint={t("tokens.nameHint")} error={errors.fields.name}>
        <Input
          id="token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("tokens.namePlaceholder")}
          maxLength={80}
        />
      </FormField>
      <SwitchRow
        title={t("tokens.readOnly")}
        hint={t("tokens.readOnlyHint")}
        checked={readOnly}
        onChange={setReadOnly}
      />
      <FormField label={t("tokens.projects")} hint={t("tokens.projectsHint")} error={errors.fields.projects}>
        <MultiPick
          items={projects.map((p) => ({
            id: p.id,
            label: p.name,
            icon: <ProjectGlyph project={p} />,
            keywords: p.key,
          }))}
          value={picked}
          onChange={setPicked}
          addLabel={t("agent.projectsPick")}
          empty={t("s.everyProject")}
        />
      </FormField>
      <FormField label={t("tokens.expires")}>
        <NativeSelect
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={EXPIRY.map((n) => ({
            value: String(n),
            label: n === 0 ? t("tokens.expires.never") : t("tokens.expires.days", { n }),
          }))}
        />
      </FormField>
    </>
  );
}
