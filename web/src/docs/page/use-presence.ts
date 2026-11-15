// "I am here, in this block": told to the server every few seconds while a
// page is open, and at once when the caret moves to another block. The
// answer is who else is here (kept in docs/store.ts for the header and the
// marks beside blocks).

import { useEffect, useRef } from "react";
import { api, ws } from "@/lib/api";
import { getState } from "@/lib/store";
import { setPresence } from "@/docs/store";
import type { PresenceEntry } from "@/docs/types";

const EVERY_MS = 4_000;

export function usePresence(docId: string, block: string | null, enabled = true) {
  const at = useRef(block);
  at.current = block;
  const say = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    const path = ws(getState().slug, `/docs/${docId}/presence`);
    let gone = false;
    say.current = () => {
      api
        .post<{ others: PresenceEntry[] }>(path, { block: at.current ?? "" })
        .then((out) => !gone && setPresence(docId, out.others ?? []))
        .catch(() => {});
    };
    say.current();
    const timer = setInterval(() => say.current(), EVERY_MS);
    const leave = () =>
      void fetch(path, {
        method: "POST",
        body: JSON.stringify({ leave: true }),
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        credentials: "same-origin",
      }).catch(() => {});
    window.addEventListener("pagehide", leave);
    return () => {
      gone = true;
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      say.current = () => {};
      leave();
      setPresence(docId, []);
    };
  }, [docId, enabled]);

  // The caret moved to another block: say so now, not at the next tick.
  useEffect(() => {
    say.current();
  }, [block]);
}
