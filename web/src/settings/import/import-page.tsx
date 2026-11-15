// Settings → Import: pick the tool, hand over its export (or say where to
// read it), check what is in it, then import.

import { type FormEvent, useEffect, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useProjects, useSlug } from "@/lib/selectors";
import { githubRepo, isWebAddress } from "@/lib/url";
import { useSettingsBase } from "@/settings/base";
import {
  checkImport,
  type Found,
  foundText,
  type ImportKind,
  type ImportRequest,
  type ImportResult,
  runImport,
  type Source,
  SOURCES,
} from "@/settings/import/data";
import { ImportOutcome } from "@/settings/import/result";
import { type Uploaded, UploadField } from "@/settings/import/upload-field";
import { FormAlert, FormField, FormFoot, NativeSelect, Note, useFieldErrors } from "@/ui/form";
import { Card, Page, Section } from "@/ui/settings-layout";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Spinner } from "@/ui/spinner";

const NEW = "+";
const FILE_LABEL = { ".csv": "import.file.csv", ".json": "import.file.json", ".zip": "import.file.zip" } as const;
const FILE_TAG: Record<string, string> = { ".csv": "CSV", ".json": "JSON", ".zip": "ZIP" };
const ext = (s: Source) => (s.accept?.split(",")[0] ?? ".zip") as keyof typeof FILE_LABEL;

function SourceCards({
  value,
  onPick,
  disabled,
}: {
  value: ImportKind | null;
  onPick: (kind: ImportKind) => void;
  disabled: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={t("import.from")} className="grid gap-2 sm:grid-cols-2">
      {SOURCES.map((s) => (
        <button
          key={s.kind}
          type="button"
          role="radio"
          aria-checked={value === s.kind}
          disabled={disabled}
          onClick={() => onPick(s.kind)}
          className={cx(
            "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
            value === s.kind
              ? "border-accent bg-accent-soft"
              : "border-line bg-surface hover:border-line-strong hover:bg-hover/60",
          )}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-ink">{t(`import.kind.${s.kind}`)}</span>
            {s.from === "file" && (
              <span className="text-2xs font-medium tracking-wide text-ink-3">{FILE_TAG[ext(s)]}</span>
            )}
          </span>
          <span className="text-xs text-ink-2">{t(`import.how.${s.kind}`)}</span>
        </button>
      ))}
    </div>
  );
}

type Phase = "idle" | "checking" | "checked" | "running";

/** The whole flow. `key` on it starts over. */
function ImportFlow({ onDone }: { onDone: (result: ImportResult, project: string) => void }) {
  const slug = useSlug();
  const projects = useProjects();
  const [kind, setKind] = useState<ImportKind | null>(null);
  const [file, setFile] = useState<Uploaded | null>(null);
  const [uploading, setUploading] = useState(false);
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [orbitWs, setOrbitWs] = useState("");
  const [orbitSession, setOrbitSession] = useState("");
  const [project, setProject] = useState("");
  const [newKey, setNewKey] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [found, setFound] = useState<Found | null>(null);
  const errors = useFieldErrors(["file", "source", "project", "token", "workspace", "kind"]);
  const source = SOURCES.find((s) => s.kind === kind);
  const busy = phase === "checking" || phase === "running";
  // On a phone the form opens below the list of tools: bring it into view once one is picked.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (kind) form.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [kind]);

  /** Anything about the source changed: what was found no longer stands. */
  function touched() {
    errors.clear();
    setFound(null);
    setPhase("idle");
  }

  function pickKind(next: ImportKind) {
    if (next === kind) return;
    setKind(next);
    setFile(null);
    setAddress("");
    setToken("");
    touched();
  }

  const projectKey = project === NEW ? newKey.trim().toUpperCase() : project;

  function request(): ImportRequest | null {
    if (!source) return null;
    const options: Record<string, string> = {};
    const req: ImportRequest = { kind: source.kind, options };
    if (source.from === "file") {
      if (!file) {
        errors.set("file", t("import.fileMissing"));
        return null;
      }
      req.file = file.id;
    } else if (source.kind === "github") {
      const repo = githubRepo(address);
      if (!repo) {
        errors.set("source", t("import.repoBad"));
        return null;
      }
      req.source = repo;
      if (token.trim()) options.token = token.trim();
    } else {
      if (!isWebAddress(address)) {
        errors.set("source", t("import.addressBad"));
        return null;
      }
      req.source = address.trim().replace(/\/+$/, "");
      if (orbitWs.trim()) options.workspace = orbitWs.trim();
      if (token.trim()) options.token = token.trim();
      if (orbitSession.trim()) options.session = orbitSession.trim();
    }
    if (source.project) {
      if (!projectKey) {
        errors.set("project", t("import.projectMissing"));
        return null;
      }
      options.project = projectKey;
    }
    return req;
  }

  async function check(e?: FormEvent) {
    e?.preventDefault();
    errors.clear();
    const req = request();
    if (!req) return;
    setPhase("checking");
    try {
      setFound(await checkImport(slug, req));
      setPhase("checked");
    } catch (err) {
      errors.fail(err);
      setPhase("idle");
    }
  }

  async function run() {
    errors.clear();
    const req = request();
    if (!req) return;
    setPhase("running");
    try {
      onDone(await runImport(slug, req), source?.project ? projectKey : "");
    } catch (err) {
      errors.fail(err);
      setPhase("checked");
    }
  }

  const nothing = found !== null && found.tasks + found.pages + found.databases === 0;
  return (
    <>
      <Section title={t("import.from")}>
        <SourceCards value={kind} onPick={pickKind} disabled={busy || uploading} />
      </Section>
      {source && (
        <Section title={source.from === "file" ? t("import.source") : t("import.sourceAddress")}>
          <Card>
            <form ref={form} onSubmit={check} className="flex scroll-my-10 flex-col gap-3.5" noValidate>
              {source.from === "file" && (
                <UploadField
                  key={source.kind}
                  accept={source.accept}
                  label={t(FILE_LABEL[ext(source)])}
                  value={file}
                  onChange={(f) => {
                    setFile(f);
                    touched();
                  }}
                  onBusy={setUploading}
                  error={errors.fields.file}
                />
              )}
              {source.kind === "github" && (
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <FormField
                    label={t("import.repo")}
                    htmlFor="imp-repo"
                    hint={t("import.repoHint")}
                    error={errors.fields.source}
                  >
                    <Input
                      id="imp-repo"
                      className="font-mono"
                      placeholder="owner/name"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={address}
                      onChange={(e) => {
                        setAddress(e.target.value);
                        touched();
                      }}
                    />
                  </FormField>
                  <FormField
                    label={`${t("import.token")} (${t("s.optional")})`}
                    htmlFor="imp-token"
                    hint={t("import.tokenHintGithub")}
                    error={errors.fields.token}
                  >
                    <Input
                      id="imp-token"
                      type="password"
                      autoComplete="off"
                      placeholder="github_pat_…"
                      value={token}
                      onChange={(e) => {
                        setToken(e.target.value);
                        touched();
                      }}
                    />
                  </FormField>
                </div>
              )}
              {source.kind === "orbit" && (
                <>
                  <FormField
                    label={t("import.address")}
                    htmlFor="imp-address"
                    hint={t("import.addressHint")}
                    error={errors.fields.source}
                  >
                    <Input
                      id="imp-address"
                      type="url"
                      placeholder="https://"
                      spellCheck={false}
                      autoCapitalize="off"
                      value={address}
                      onChange={(e) => {
                        setAddress(e.target.value);
                        touched();
                      }}
                    />
                  </FormField>
                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <FormField
                      label={t("import.orbitWorkspace")}
                      htmlFor="imp-orbit-ws"
                      hint={t("import.orbitWorkspaceHint")}
                      error={errors.fields.workspace}
                    >
                      <Input
                        id="imp-orbit-ws"
                        spellCheck={false}
                        autoCapitalize="off"
                        value={orbitWs}
                        onChange={(e) => {
                          setOrbitWs(e.target.value);
                          touched();
                        }}
                      />
                    </FormField>
                    <FormField
                      label={t("import.token")}
                      htmlFor="imp-token"
                      hint={t("import.tokenHintOrbit")}
                      error={errors.fields.token}
                    >
                      <Input
                        id="imp-token"
                        type="password"
                        autoComplete="off"
                        value={token}
                        onChange={(e) => {
                          setToken(e.target.value);
                          touched();
                        }}
                      />
                    </FormField>
                  </div>
                  <FormField
                    label={t("import.orbitSession")}
                    htmlFor="imp-orbit-session"
                    hint={t("import.orbitSessionHint")}
                    error={errors.fields.session}
                  >
                    <Input
                      id="imp-orbit-session"
                      type="password"
                      autoComplete="off"
                      value={orbitSession}
                      onChange={(e) => {
                        setOrbitSession(e.target.value);
                        touched();
                      }}
                    />
                  </FormField>
                </>
              )}
              {source.project && (
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <FormField
                    label={t("import.project")}
                    htmlFor="imp-project"
                    hint={t("import.projectHint")}
                    error={project === NEW ? undefined : errors.fields.project}
                  >
                    <NativeSelect
                      id="imp-project"
                      value={project}
                      onChange={(v) => {
                        setProject(v);
                        touched();
                      }}
                      options={[
                        { value: "", label: "—" },
                        ...projects.map((p) => ({ value: p.key, label: `${p.key} · ${p.name}` })),
                        { value: NEW, label: t("import.projectNew") },
                      ]}
                    />
                  </FormField>
                  {project === NEW && (
                    <FormField
                      label={t("import.projectKey")}
                      htmlFor="imp-project-key"
                      hint={t("import.projectKeyHint")}
                      error={errors.fields.project}
                    >
                      <Input
                        id="imp-project-key"
                        className="font-mono uppercase"
                        maxLength={6}
                        spellCheck={false}
                        value={newKey}
                        onChange={(e) => {
                          setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                          touched();
                        }}
                      />
                    </FormField>
                  )}
                </div>
              )}
              {found && <Note tone={nothing ? "neutral" : "ok"}>{foundText(found)}</Note>}
              {/* The server names what it could not read "file" even when it was an address. */}
              <FormAlert>{errors.form || (source.from === "address" ? errors.fields.file : "")}</FormAlert>
              <FormFoot
                status={
                  busy ? (
                    <span className="flex items-center gap-2" aria-live="polite">
                      <Spinner
                        className="size-3.5"
                        label={phase === "running" ? t("import.running") : t("import.checking")}
                      />
                      {phase === "running" ? t("import.runningHint") : t("import.checking")}
                    </span>
                  ) : (
                    !found && <span className="text-xs text-ink-3">{t("import.checkFirst")}</span>
                  )
                }
              >
                <Button type="submit" variant={found ? "secondary" : "primary"} disabled={busy || uploading}>
                  {t("import.check")}
                </Button>
                <Button
                  variant="primary"
                  disabled={phase !== "checked" || nothing || uploading}
                  onClick={() => void run()}
                >
                  {phase === "running" ? t("import.running") : t("import.run")}
                </Button>
              </FormFoot>
            </form>
          </Card>
        </Section>
      )}
    </>
  );
}

export function ImportPage() {
  const base = useSettingsBase();
  const [round, setRound] = useState(0);
  const [done, setDone] = useState<{ result: ImportResult; project: string } | null>(null);
  return (
    <Page title={t("import.title")} lead={t("import.lead")} back={base}>
      {done ? (
        <ImportOutcome
          result={done.result}
          project={done.project}
          onAgain={() => {
            setDone(null);
            setRound((n) => n + 1);
          }}
        />
      ) : (
        <ImportFlow key={round} onDone={(result, project) => setDone({ result, project })} />
      )}
    </Page>
  );
}
