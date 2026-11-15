// The insight endpoints name people by handle ("@coder"); the store keys
// them by id. This finds one from the other.

import { useMemo } from "react";
import { useLookupEvenIfGone } from "@/data/selectors";
import type { Member } from "@/types/core";

/** Members by handle, without the "@". */
export function useMembersByHandle(): (handle: string | undefined) => Member | undefined {
  // The endpoints name past work too: a member since removed is still found.
  const members = useLookupEvenIfGone("members");
  return useMemo(() => {
    const map = new Map<string, Member>();
    for (const m of Object.values(members)) map.set(m.handle.toLowerCase(), m);
    return (handle) => (handle ? map.get(handle.replace(/^@/, "").toLowerCase()) : undefined);
  }, [members]);
}
