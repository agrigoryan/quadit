// What the two token pages share (a person's own tokens under Me, an agent's
// on its page): the list, the dialog that makes a token, revoking one, and a
// token's scopes as badges. Each page brings its own words and its own fields.
// The key the token list is cached under is here too.

import { useMutation, useQuery } from "@tanstack/react-query";
import { type ComponentType, type Dispatch, type ReactNode, type SetStateAction, useState } from "react";
import { api, workspacePath } from "@/data/api";
import { inWorkspace, queryClient } from "@/data/query";
import { useSlug } from "@/data/selectors";
import type { Token } from "@/settings/agents/data";
import { type FieldErrors, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { Badge } from "@/ui/badge";

const tokensKey = (slug: string) => [...inWorkspace(slug), "tokens"] as const;

const tokensChanged = (slug: string) => queryClient.invalidateQueries({ queryKey: tokensKey(slug) });

/**
 * The tokens issued to one member of this workspace. The server lists them
 * all in one answer, which both pages share. `enabled` false asks nothing
 * (the server lists an agent's tokens for admins only).
 */
export function useTokens(userId: string, enabled = true) {
  const slug = useSlug();
  return useQuery({
    queryKey: tokensKey(slug),
    queryFn: ({ signal }) => api.get<{ tokens: Token[] }>(workspacePath(slug, "/tokens"), signal),
    select: (out) => out.tokens.filter((tk) => tk.user_id === userId),
    enabled,
  });
}

/** Revokes a token; the list is asked again either way. */
export function useRevokeToken() {
  const slug = useSlug();
  return useMutation({
    mutationFn: (id: string) => api.del(workspacePath(slug, `/tokens/${id}`)),
    onSettled: () => tokensChanged(slug),
  });
}

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
  /** The narrow dialog. */
  compact?: boolean;
  /** Days until it expires, as the dialog opens. */
  days: number;
  /** The page's fields, in its order: the name first, so it has the focus when the dialog opens. */
  fields: ComponentType<TokenFieldsProps>;
  onClose: () => void;
  onCreated: (created: CreatedToken) => void;
}

/** Makes a token for `user`. The answer holds the token itself, which the page shows once. */
export function CreateTokenDialog({
  user,
  title,
  description,
  create,
  compact,
  days: firstDays,
  fields: Fields,
  onClose,
  onCreated,
}: CreateProps) {
  const slug = useSlug();
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [days, setDays] = useState(firstDays);
  const errors = useFieldErrors(["name", "projects"]);

  const make = useMutation({
    mutationFn: () =>
      api.post<CreatedToken>(workspacePath(slug, "/tokens"), {
        user,
        name: name.trim(),
        read_only: readOnly,
        projects,
        expires_days: days,
      }),
    onSuccess: () => tokensChanged(slug),
  });

  async function submit() {
    onCreated(await make.mutateAsync());
  }

  return (
    <FormDialog
      title={title}
      description={description}
      size={compact ? "sm" : "md"}
      submit={create}
      errors={errors}
      onSubmit={submit}
      onClose={onClose}
    >
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
    </FormDialog>
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
