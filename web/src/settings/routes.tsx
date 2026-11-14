import { Route, Routes } from "react-router";
import { t } from "@/lib/i18n";
import { ComingPage } from "@/shell/placeholders";

/** Everything under /:ws/settings. Loaded on demand. */
export default function SettingsRoutes() {
  return (
    <Routes>
      <Route path="*" element={<ComingPage name={t("nav.settings")} />} />
    </Routes>
  );
}
