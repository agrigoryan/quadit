import { FilePlus2, FileText } from "lucide-react";
import { useEffect } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { usePageTitle } from "@/lib/ui-state";
import { setNavigator } from "@/docs/nav";
import { DocPage } from "@/docs/page/doc-page";
import { DocsTree } from "@/docs/tree/docs-tree";
import { createAndOpen } from "@/docs/tree/new-page";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/empty";

/** Everything under /:ws/docs. Loaded on demand. */
export default function DocsRoutes() {
  const navigate = useNavigate();
  const location = useLocation();
  // Chips inside the editor navigate without router hooks (see docs/nav.ts).
  useEffect(() => {
    setNavigator(navigate, location);
    return () => setNavigator(null, null);
  }, [navigate, location]);

  return (
    <Routes>
      <Route index element={<DocsArea />} />
      <Route path=":id" element={<DocsArea />} />
    </Routes>
  );
}

/** The tree on the left, the page on the right. On a narrow screen one of the two shows at a time. */
function DocsArea() {
  const { id } = useParams();
  return (
    <div className="flex h-full">
      <aside className={cx("w-64 shrink-0 flex-col border-r border-line bg-canvas", id ? "hidden lg:flex" : "flex max-lg:w-full")}>
        <div className="flex h-10 shrink-0 items-center justify-between pr-2 pl-4">
          <h1 className="text-sm font-semibold">{t("docs.title")}</h1>
          <Button variant="ghost" size="sm" onClick={() => createAndOpen({})} className="gap-1">
            <FilePlus2 className="size-3.5" />
            {t("docs.new.page")}
          </Button>
        </div>
        <DocsTree className="flex-1" />
      </aside>
      <section className={cx("min-w-0 flex-1", !id && "max-lg:hidden")}>{id ? <DocPage key={id} id={id} /> : <DocsHome />}</section>
    </div>
  );
}

function DocsHome() {
  usePageTitle(t("docs.title"));
  return (
    <EmptyState
      icon={<FileText />}
      title={t("docs.home.title")}
      hint={t("docs.home.hint")}
      action={
        <Button variant="primary" onClick={() => createAndOpen({})}>
          {t("docs.new.page")}
        </Button>
      }
    />
  );
}
