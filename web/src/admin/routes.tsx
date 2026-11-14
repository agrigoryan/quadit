import { Route, Routes } from "react-router";
import { t } from "@/lib/i18n";
import { ComingPage } from "@/shell/placeholders";

/** The install's admin area, at /admin. For the people who run the install. Loaded on demand. */
export default function AdminRoutes() {
  return (
    <Routes>
      <Route path="*" element={<ComingPage name={t("admin.title")} />} />
    </Routes>
  );
}
