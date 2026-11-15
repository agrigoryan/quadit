// Where settings live. Who may change them is lib/access.ts (useCan).

import { useSlug } from "@/lib/selectors";

/** The address of the settings area: "/games/settings". Pages pass it to <Page back>. */
export const useSettingsBase = () => `/${useSlug()}/settings`;
