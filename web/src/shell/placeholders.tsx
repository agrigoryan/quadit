import { Compass, Hammer } from "lucide-react";
import { Link } from "react-router";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { usePageTitle } from "@/lib/ui-state";
import { EmptyState } from "@/ui/empty";

/** A page for a part of the product that a later wave builds. */
export function ComingPage({ name }: { name: string }) {
  usePageTitle(name);
  return <EmptyState icon={<Hammer />} title={t("common.comingTitle", { name })} hint={t("common.comingHint")} />;
}

export function NotFoundPage() {
  const slug = useSlug();
  usePageTitle(t("common.notFound"));
  return (
    <EmptyState
      icon={<Compass />}
      title={t("common.notFound")}
      hint={t("common.notFoundHint")}
      action={
        <Link to={`/${slug}/my-work`} className="text-sm font-medium text-accent-text underline-offset-2 hover:underline">
          {t("nav.myWork")}
        </Link>
      }
    />
  );
}
