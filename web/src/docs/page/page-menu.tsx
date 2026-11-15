// The "more" menu of a page: versions, Markdown in and out, what links
// here, the repository file it mirrors, and delete.

import {
  BookmarkPlus,
  Download,
  FileUp,
  GitBranch,
  History,
  Link2,
  MoreHorizontal,
  Spline,
  Trash2,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router";
import { errorMessage, workspacePath } from "@/lib/api";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { keepVersion, trashDoc } from "@/docs/actions";
import { useDocsArea } from "@/docs/area";
import { docTitle } from "@/docs/data";
import { fileNameOf, saveText } from "@/docs/files";
import { BacklinksDialog, useBacklinks } from "@/docs/page/backlinks";
import { ImportDialog } from "@/docs/page/import-dialog";
import { useDocsStore } from "@/docs/store";
import type { Doc } from "@/docs/types";
import { IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu";

const VersionsDialog = lazy(() => import("@/docs/page/versions-dialog"));

/** Downloads a page as the Markdown the server renders for it. */
async function exportMarkdown(slug: string, doc: Doc) {
  try {
    const res = await fetch(workspacePath(slug, `/docs/${doc.id}?format=md&full=1`), { credentials: "same-origin" });
    if (!res.ok) throw new Error(res.statusText);
    saveText(fileNameOf(docTitle(doc)), `# ${docTitle(doc)}\n\n${await res.text()}`);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function PageMenu({ doc }: { doc: Doc }) {
  const slug = useSlug();
  const { base } = useDocsArea();
  const navigate = useNavigate();
  const source = useDocsStore((s) => s.meta[doc.id]?.source);
  const backlinks = useBacklinks(doc.id);
  const [dialog, setDialog] = useState<"versions" | "import" | "backlinks" | null>(null);
  const isPage = doc.kind !== "database";
  const canWrite = isPage && !doc.generated && !(source?.authority === "repo" && source.write_mode === "none");
  // After the menu has closed and given the focus back.
  const later = (what: typeof dialog) => () => setTimeout(() => setDialog(what), 0);

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={t("docs.menu.more")}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-56">
          {isPage && (
            <>
              <MenuItem icon={<History />} onSelect={later("versions")}>
                {t("docs.menu.versions")}
              </MenuItem>
              <MenuItem
                icon={<BookmarkPlus />}
                onSelect={() =>
                  void keepVersion(doc.id, "")
                    .then(() => toast.info(t("docs.versions.kept")))
                    .catch(() => {})
                }
              >
                {t("docs.versions.keepNow")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Download />} onSelect={() => void exportMarkdown(slug, doc)}>
                {t("docs.menu.export")}
              </MenuItem>
              {canWrite && (
                <MenuItem icon={<FileUp />} onSelect={later("import")}>
                  {t("docs.menu.import")}
                </MenuItem>
              )}
              <MenuSeparator />
            </>
          )}
          <MenuItem
            icon={<Link2 />}
            onSelect={() =>
              void copyText(`${location.origin}/${slug}/docs/${doc.id}`).then((ok) =>
                toast.info(t(ok ? "common.copied" : "common.copyFailed")),
              )
            }
          >
            {t("docs.copyLink")}
          </MenuItem>
          <MenuItem
            icon={<Spline />}
            hint={backlinks.length ? String(backlinks.length) : undefined}
            onSelect={later("backlinks")}
          >
            {t("docs.backlinks.title")}
          </MenuItem>
          {source && (
            <>
              <MenuSeparator />
              <MenuLabel>{t("docs.source.label")}</MenuLabel>
              <MenuItem icon={<GitBranch />} disabled className="h-auto py-1 opacity-100!">
                <span className="block truncate">{source.repo}</span>
                <span className="block truncate text-xs text-ink-3">
                  {[source.branch, doc.source_path ?? source.subdir].filter(Boolean).join(" · ") ||
                    t(`docs.source.${source.write_mode}`)}
                </span>
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 />}
            danger
            onSelect={() => {
              trashDoc(doc.id);
              void navigate(doc.parent_id ? `${base}/${doc.parent_id}` : base);
            }}
          >
            {t("docs.delete")}
          </MenuItem>
        </MenuContent>
      </Menu>
      {dialog === "versions" && (
        <Suspense fallback={null}>
          <VersionsDialog doc={doc} canRestore={canWrite} onClose={() => setDialog(null)} />
        </Suspense>
      )}
      <ImportDialog doc={doc} open={dialog === "import"} onClose={() => setDialog(null)} />
      <BacklinksDialog docId={doc.id} open={dialog === "backlinks"} onClose={() => setDialog(null)} />
    </>
  );
}
