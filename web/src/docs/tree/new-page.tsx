// Starting a page: blank, a database, from a Markdown file, or one of the
// pages the server builds from data.

import { Database, FileText, FileUp, Sparkles } from "lucide-react";
import { t } from "@/lib/i18n";
import { createDoc, type NewDoc } from "@/docs/actions";
import { pickMarkdown, titleOf } from "@/docs/files";
import { openDoc } from "@/docs/nav";
import { setOpen } from "@/docs/tree/state";
import { MenuItem, MenuLabel, MenuSeparator } from "@/ui/menu";

/** Makes the page, opens it, and opens the tree down to it. */
export function createAndOpen(input: NewDoc): string {
  const id = createDoc(input);
  if (input.parentId) setOpen(input.parentId, true);
  openDoc(id);
  return id;
}

export async function createFromMarkdown(base: NewDoc) {
  const file = await pickMarkdown();
  if (!file) return;
  const { title, body } = titleOf(file.text, file.name);
  createAndOpen({ ...base, title, markdown: body });
}

const GENERATED = [
  { kind: "decision_log", key: "docs.new.decisionLog" },
  { kind: "changelog", key: "docs.new.changelog" },
  { kind: "open_questions", key: "docs.new.openQuestions" },
] as const;

interface Props {
  parentId?: string;
  /** Make it private to the person. */
  private?: boolean;
  /** Offer the pages built from data (only at the top of the team's pages). */
  generated?: boolean;
}

/** The entries of a "new page" menu; put them inside a MenuContent. */
export function NewPageItems({ parentId, private: isPrivate, generated }: Props) {
  const base: NewDoc = { parentId, private: isPrivate };
  return (
    <>
      <MenuItem icon={<FileText />} onSelect={() => createAndOpen(base)}>
        {t(parentId ? "docs.new.subpage" : "docs.new.blank")}
      </MenuItem>
      <MenuItem icon={<Database />} onSelect={() => createAndOpen({ ...base, kind: "database" })}>
        {t("docs.new.database")}
      </MenuItem>
      <MenuItem icon={<FileUp />} onSelect={() => void createFromMarkdown(base)}>
        {t("docs.new.fromMarkdown")}
      </MenuItem>
      {generated && (
        <>
          <MenuSeparator />
          <MenuLabel>{t("docs.new.generated")}</MenuLabel>
          {GENERATED.map((g) => (
            <MenuItem key={g.kind} icon={<Sparkles />} onSelect={() => createAndOpen({ title: t(g.key), generated: g.kind })}>
              {t(g.key)}
            </MenuItem>
          ))}
        </>
      )}
    </>
  );
}
