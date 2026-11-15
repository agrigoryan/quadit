// A page's kept versions: the list, a read-only look at one, and putting
// the page back to it. The server keeps a version by itself now and then
// while a page is edited; "keep a version now" makes a named one.

import { BookmarkPlus, History } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { api, workspacePath } from "@/lib/api";
import { queryClient } from "@/lib/query";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useLookupEvenIfGone, useSlug } from "@/lib/selectors";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import { keepVersion, revertTo } from "@/docs/actions";
import { docsKeys } from "@/docs/store";
import type { BlockTree, Doc, DocVersion } from "@/lib/types-docs";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Loading } from "@/ui/spinner";
import { Ago } from "@/ui/ago";

const Preview = lazy(() => import("@/docs/editor/preview"));

interface Props {
  doc: Doc;
  /** False for pages that cannot be edited here: they can be looked at, not put back. */
  canRestore: boolean;
  /** False for one who may not change the page: no new version either. */
  canKeep: boolean;
  onClose: () => void;
}

export default function VersionsDialog({ doc, canRestore, canKeep, onClose }: Props) {
  const slug = useSlug();
  // Who kept each version, one since removed from the workspace included.
  const members = useLookupEvenIfGone("members");
  const list = useQuery({
    queryKey: docsKeys.versions(slug, doc.id),
    queryFn: ({ signal }) =>
      api
        .get<{ versions: DocVersion[] }>(workspacePath(slug, `/docs/${doc.id}/versions`), signal)
        .then((out) => out.versions ?? []),
    meta: { failureToast: "docs.versions.loadFailed" },
  });
  const versions = list.data ?? null;
  const [chosen, setPicked] = useState<string | null>(null);
  // The newest until one is picked.
  const picked = chosen ?? versions?.[0]?.id ?? null;
  const version = useQuery({
    queryKey: docsKeys.version(slug, doc.id, picked ?? ""),
    queryFn: ({ signal }) =>
      api
        .get<{ blocks: BlockTree[] | null }>(workspacePath(slug, `/docs/${doc.id}/versions/${picked}`), signal)
        .then((out) => out.blocks ?? []),
    enabled: !!picked,
    staleTime: Infinity,
  });
  const shown = picked && version.data ? { id: picked, blocks: version.data } : null;
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function keep() {
    setBusy(true);
    try {
      await keepVersion(doc.id, label.trim());
      setLabel("");
      setPicked(null);
      await queryClient.invalidateQueries({ queryKey: docsKeys.versions(slug, doc.id), exact: true });
    } catch {
      // mutate() has shown why.
    }
    setBusy(false);
  }

  async function restore() {
    if (!picked) return;
    setBusy(true);
    try {
      await revertTo(doc.id, picked);
      toast.info(t("docs.versions.restored"));
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("docs.menu.versions")}
      size="lg"
      className="sm:!top-[6vh] sm:!max-h-[88vh]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
          {canRestore && (
            <Button variant="primary" disabled={!picked || busy} onClick={() => void restore()}>
              {t("docs.versions.restore")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex min-h-[50vh] flex-col gap-3 sm:flex-row">
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-60">
          {canKeep && (
            <form
              className="flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void keep();
              }}
            >
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("docs.versions.labelPlaceholder")}
                aria-label={t("docs.versions.labelPlaceholder")}
                className="h-7"
              />
              <Button
                type="submit"
                disabled={busy}
                title={t("docs.versions.keepNow")}
                aria-label={t("docs.versions.keepNow")}
                className="px-2"
              >
                <BookmarkPlus className="size-4" />
              </Button>
            </form>
          )}
          {versions === null ? (
            <Loading />
          ) : versions.length === 0 ? (
            <p className="px-1 py-4 text-sm text-ink-3">{t("docs.versions.none")}</p>
          ) : (
            <ul className="max-h-40 overflow-y-auto sm:max-h-[60vh]" aria-label={t("docs.menu.versions")}>
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-pressed={picked === v.id}
                    onClick={() => setPicked(v.id)}
                    className={cx(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover",
                      picked === v.id && "bg-press",
                    )}
                  >
                    <Avatar member={members[v.created_by]} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{v.label || t("docs.versions.auto")}</span>
                      <span className="block text-xs text-ink-3" title={exact(v.created_at)}>
                        <Ago ms={v.created_at} /> · {members[v.created_by]?.name ?? t("common.someone")}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="min-h-64 min-w-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface py-3">
          {!picked ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-ink-3">
              <History className="size-5" />
              <p className="text-sm">{t("docs.versions.pick")}</p>
            </div>
          ) : shown?.id !== picked ? (
            <Loading />
          ) : (
            <Suspense fallback={<Loading />}>
              <Preview key={shown.id} blocks={shown.blocks} />
            </Suspense>
          )}
        </div>
      </div>
    </Dialog>
  );
}
