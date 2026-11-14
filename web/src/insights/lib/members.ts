// The insight endpoints name people by handle ("@coder"); the store keys
// them by id. This finds one from the other.

import { useMemo } from "react";
import { useCollection } from "@/lib/selectors";
import type { Member } from "@/lib/types";

/** Members by handle, without the "@". */
export function useMembersByHandle(): (handle: string | undefined) => Member | undefined {
  const members = useCollection("members");
  return useMemo(() => {
    const map = new Map<string, Member>();
    for (const m of Object.values(members)) map.set(m.handle.toLowerCase(), m);
    return (handle) => (handle ? map.get(handle.replace(/^@/, "").toLowerCase()) : undefined);
  }, [members]);
}
