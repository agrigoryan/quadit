import { Compass, Hammer, Lock } from "lucide-react";
import { Link, useParams } from "react-router";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { useStore } from "@/lib/store";
import { usePageTitle } from "@/lib/ui-state";
import { EmptyState } from "@/ui/empty";

/** A page for a part of the product that a later wave builds. */
export function ComingPage({ name }: { name: string }) {
  usePageTitle(name);
  return <EmptyState icon={<Hammer />} title={t("common.comingTitle", { name })} hint={t("common.comingHint")} />;
}

/** True for a project (by its key) that the person could see until their access was narrowed while the app was open. */
export const useLostProject = (key: string | undefined): boolean =>
  useStore((s) => !!key && s.lostProjects.includes(key.toUpperCase()));

function MyWorkLink() {
  const slug = useSlug();
  return (
    <Link to={`/${slug}/my-work`} className="text-sm font-medium text-accent-text underline-offset-2 hover:underline">
      {t("nav.myWork")}
    </Link>
  );
}

/** In place of a page or a task of a project the person has just lost. */
export function LostProject() {
  return (
    <EmptyState
      icon={<Lock />}
      title={t("common.lostProject")}
      hint={t("common.lostProjectHint")}
      action={<MyWorkLink />}
    />
  );
}

export function NotFoundPage() {
  // On a project's page (/:ws/p/:key/…) the project may be one the person has just lost: say that instead.
  const lost = useLostProject(useParams().key);
  usePageTitle(t(lost ? "common.lostProject" : "common.notFound"));
  if (lost) return <LostProject />;
  return (
    <EmptyState
      icon={<Compass />}
      title={t("common.notFound")}
      hint={t("common.notFoundHint")}
      action={<MyWorkLink />}
    />
  );
}
