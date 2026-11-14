// A page's kept versions: the list, a read-only look at one, and putting
// the page back to it. The server keeps a version by itself now and then
// while a page is edited; "keep a version now" makes a named one.

import { BookmarkPlus, History } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, errorMessage, ws } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useCollection, useSlug } from "@/lib/selectors";
import { exact } from "@/lib/time";
import { toast } from "@/lib/toast";
import { keepVersion, revertTo } from "@/docs/actions";
import type { BlockTree, Doc, DocVersion } from "@/docs/types";
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
  onClose: () => void;
}

export default function VersionsDialog({ doc, canRestore, onClose }: Props) {
  const slug = useSlug();
  const members = useCollection("members");
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: string; blocks: BlockTree[] } | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api.get<{ versions: DocVersion[] }>(ws(slug, `/docs/${doc.id}/versions`)).then(
        (out) => {
          setVersions(out.versions ?? []);
          setPicked((cur) => cur ?? out.versions?.[0]?.id ?? null);
        },
        (err: unknown) => toast.error(errorMessage(err)),
      ),
    [slug, doc.id],
  );

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!picked) return;
    const ctl = new AbortController();
    api
      .get<{ blocks: BlockTree[] | null }>(ws(slug, `/docs/${doc.id}/versions/${picked}`), ctl.signal)
      .then((out) => setShown({ id: picked, blocks: out.blocks ?? [] }))
      .catch(() => {});
    return () => ctl.abort();
  }, [slug, doc.id, picked]);

  async function keep() {
    setBusy(true);
    try {
      await keepVersion(doc.id, label.trim());
      setLabel("");
      setPicked(null);
      await load();
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
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void keep();
            }}
          >
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("docs.versions.labelPlaceholder")} aria-label={t("docs.versions.labelPlaceholder")} className="h-7" />
            <Button type="submit" disabled={busy} title={t("docs.versions.keepNow")} aria-label={t("docs.versions.keepNow")} className="px-2">
              <BookmarkPlus className="size-4" />
            </Button>
          </form>
          {versions === null ? (
            <Loading />
          ) : versions.length === 0 ? (
            <p className="px-1 py-4 text-sm text-ink-3">{t("docs.versions.none")}</p>
          ) : (
            <ul className="max-h-40 overflow-y-auto sm:max-h-[60vh]" role="listbox" aria-label={t("docs.menu.versions")}>
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={picked === v.id}
                    onClick={() => setPicked(v.id)}
                    className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover", picked === v.id && "bg-press")}
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
