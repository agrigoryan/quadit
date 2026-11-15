// Where settings live. Who may change them is data/access.ts (useCan).

import { useSlug } from "@/data/selectors";

/** The address of the settings area: "/games/settings". Pages pass it to <Page back>. */
export const useSettingsBase = () => `/${useSlug()}/settings`;
