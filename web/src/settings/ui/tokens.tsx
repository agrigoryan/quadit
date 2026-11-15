// What the two token pages share (a person's own tokens under Me, an agent's
// on its page): the dialog that makes a token, and a token's scopes as badges.
// Each page brings its own words and its own fields.

import { type ComponentType, type Dispatch, type FormEvent, type ReactNode, type SetStateAction, useState } from "react";
import { api, ws } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { type FieldErrors, FormAlert, useFieldErrors, useSubmit } from "@/settings/ui/form";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";

/** What the server answers when a token is made: the token itself, this once, and its row in the list. */
export interface CreatedToken {
  token: string;
  info: { name: string };
}

/** What the dialog holds while a token is being described. The page's fields show it and change it. */
export interface TokenFieldsProps {
  name: string;
  setName: (name: string) => void;
  readOnly: boolean;
  setReadOnly: (readOnly: boolean) => void;
  /** The projects the token is held to, as the page's picker names them; none is every project. */
  projects: string[];
  setProjects: Dispatch<SetStateAction<string[]>>;
  /** Days until it expires; 0 is never. */
  days: number;
  setDays: (days: number) => void;
  /** Knows "name" and "projects"; anything else lands above the buttons. */
  errors: FieldErrors;
}

interface CreateProps {
  /** "@handle" of an agent, or "me". */
  user: string;
  title: string;
  description?: string;
  /** The word on the button that makes it. */
  create: string;
  /** The narrow dialog, with its rows closer together. */
  compact?: boolean;
  /** Days until it expires, as the dialog opens. */
  days: number;
  /** The page's fields, in its order: the name first, so it has the focus when the dialog opens. */
  fields: ComponentType<TokenFieldsProps>;
  onClose: () => void;
  onCreated: (created: CreatedToken) => void;
}

/** Makes a token for `user`. The answer holds the token itself, which the page shows once. */
export function CreateTokenDialog({ user, title, description, create, compact, days: firstDays, fields: Fields, onClose, onCreated }: CreateProps) {
  const slug = useSlug();
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [days, setDays] = useState(firstDays);
  const errors = useFieldErrors(["name", "projects"]);
  const { busy, run } = useSubmit(errors, { once: true });

  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      onCreated(await api.post<CreatedToken>(ws(slug, "/tokens"), { user, name: name.trim(), read_only: readOnly, projects, expires_days: days }));
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description={description}
      size={compact ? "sm" : "md"}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="token-create" variant="primary" disabled={busy}>
            {create}
          </Button>
        </>
      }
    >
      <form id="token-create" onSubmit={submit} className={cx("flex flex-col", compact ? "gap-3.5" : "gap-4")}>
        <Fields
          name={name}
          setName={setName}
          readOnly={readOnly}
          setReadOnly={setReadOnly}
          projects={projects}
          setProjects={setProjects}
          days={days}
          setDays={setDays}
          errors={errors}
        />
        <FormAlert>{errors.form}</FormAlert>
      </form>
    </Dialog>
  );
}

interface ScopeProps {
  /** Space-separated: "read" and "project:<id>" entries. Empty means everything the member may do. */
  scopes: string | undefined;
  /** The page's word for a token that may only read. */
  readOnly: string;
  /** The page's badges for the projects the token is held to, given their ids. */
  projects: (ids: string[]) => ReactNode;
}

/** What a token is narrowed to, as badges: read-only, and the projects it is held to. */
export function ScopeBadges({ scopes, readOnly, projects }: ScopeProps) {
  const parts = (scopes ?? "").split(" ").filter(Boolean);
  const ids = parts.filter((p) => p.startsWith("project:")).map((p) => p.slice("project:".length));
  return (
    <>
      {parts.includes("read") && <Badge>{readOnly}</Badge>}
      {ids.length > 0 && projects(ids)}
    </>
  );
}
