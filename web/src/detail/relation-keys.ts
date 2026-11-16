// M then a letter relates the open task to another: B blocked by, X
// blocking, R related to, M a duplicate of. The letters are read where every
// two-key sequence is (shell/sequences.tsx: a second listener would break
// G's); this file holds their table, and how they reach the open task: the
// task registers what starts a relation on it while it is shown and may be
// changed. M is a sequence only while one is.

import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";
import type { Key } from "@/lib/i18n";
import type { AddType } from "@/detail/relations";

/** The letters after M, in the order the hint and the shortcuts sheet list them, each with what it does in words. */
export const RELATION_KEYS: { key: string; type: AddType; what: Key }[] = [
  { key: "b", type: "blocked_by", what: "shortcuts.blockedBy" },
  { key: "x", type: "blocks", what: "shortcuts.blocking" },
  { key: "r", type: "relates", what: "shortcuts.related" },
  { key: "m", type: "duplicates", what: "shortcuts.duplicate" },
];

/** What M's letters reach: how the open task starts a relation of a kind, while a task that may be changed is open. */
export const useRelationKeys = create<{ relate: ((type: AddType) => void) | null }>(() => ({ relate: null }));

/** Makes M's letters start a relation on this task, with `relate`, while it is drawn and `enabled`. */
export function useTakeRelationKeys(relate: (type: AddType) => void, enabled: boolean) {
  // The task's own as of the last render, read when the letter comes.
  const latest = useEffectEvent((type: AddType) => relate(type));
  useEffect(() => {
    if (!enabled) return;
    const taken = (type: AddType) => latest(type);
    useRelationKeys.setState({ relate: taken });
    return () => {
      // A task opened meanwhile may have taken them already.
      if (useRelationKeys.getState().relate === taken) useRelationKeys.setState({ relate: null });
    };
  }, [enabled]);
}
