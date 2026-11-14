import { Route, Routes } from "react-router";
import { t } from "@/lib/i18n";
import { ComingPage } from "@/shell/placeholders";

/** Everything under /:ws/docs. Loaded on demand. */
export default function DocsRoutes() {
  return (
    <Routes>
      <Route path="*" element={<ComingPage name={t("nav.docs")} />} />
    </Routes>
  );
}
