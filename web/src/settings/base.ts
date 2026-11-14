// Where settings live, and who may change them.

import { useMe, useSlug } from "@/lib/selectors";

/** The address of the settings area: "/games/settings". Pages pass it to <Page back>. */
export const useSettingsBase = () => `/${useSlug()}/settings`;

/** Workspace admins and owners may change the workspace; members mostly look. */
export const useIsAdmin = () => useMe().role !== "member";
