import type { Changes } from "@/lib/changes.gen";
import { useState } from "react";
import { t } from "@/lib/i18n";
import { mutate } from "@/lib/mutate";
import type { Member } from "@/lib/types";
import { FormField, Note, useFieldErrors } from "@/ui/form";
import { FormDialog } from "@/ui/form-dialog";
import { MemberScopeFields, sameScope, scopeArg, scopeDraftOf } from "@/settings/workspace/scope-fields";
import { Input } from "@/ui/input";

/** Changes how a member is mentioned and described in this workspace, and what they may see and change. */
export function EditMemberDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const [handle, setHandle] = useState(member.handle);
  const [title, setTitle] = useState(member.title ?? "");
  const [scope, setScope] = useState(() => scopeDraftOf(member));
  const errors = useFieldErrors(["handle", "title", "scope", "projects"]);
  const owner = member.role === "owner";

  async function save() {
    const args: Changes["member.update"] = { id: member.user_id, handle: handle.trim(), title: title.trim() };
    if (!owner && !sameScope(scope, scopeDraftOf(member))) args.scope = scopeArg(scope);
    await mutate({ type: "member.update", args }, undefined, { quiet: true });
  }

  return (
    <FormDialog
      title={t("members.editTitle", { name: member.name })}
      size="sm"
      submit={t("common.save")}
      errors={errors}
      onSubmit={save}
      onClose={onClose}
    >
      <FormField
        label={t("members.handle")}
        htmlFor="m-handle"
        hint={t("members.handleHint", { handle: handle || member.handle })}
        error={errors.fields.handle}
      >
        <Input
          id="m-handle"
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
          autoCapitalize="none"
          spellCheck={false}
        />
      </FormField>
      <FormField
        label={t("members.titleField")}
        htmlFor="m-title"
        hint={t("members.titleHint")}
        error={errors.fields.title}
      >
        <Input id="m-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <div className="flex flex-col gap-3.5 border-t border-line pt-3.5">
        {owner ? (
          <Note>{t("members.ownerScope")}</Note>
        ) : (
          <MemberScopeFields value={scope} onChange={setScope} error={errors.fields.scope ?? errors.fields.projects} />
        )}
      </div>
    </FormDialog>
  );
}
