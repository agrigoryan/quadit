// "G then a letter" goes to a place: G I the inbox, G M My work, G T the
// tasks of the project in view. The places are the table in
// shell/destinations.tsx. After G, a small card lists what can follow.

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { t } from "@/lib/i18n";
import { useKeySequences, usePendingKey } from "@/lib/key-sequence";
import { useStore } from "@/lib/store";
import { DESTINATIONS, destinationPath, type Where } from "@/shell/destinations";
import { projectInView } from "@/shell/project-in-view";
import { Kbd } from "@/ui/kbd";

const PREFIX = "g";
/** Someone who knows the letter has typed it by now: the card is for those who paused. */
const HINT_AFTER_MS = 250;

const keyed = DESTINATIONS.filter((place) => place.key);

/** Where the places are, for the page that is showing now. */
function useWhere(): () => Where {
  const location = useLocation();
  const latest = useRef(location);
  latest.current = location;
  return () => {
    const { slug, user } = useStore.getState();
    return { slug, project: projectInView(latest.current), installAdmin: !!user?.is_admin };
  };
}

/** Turns the sequences on. Called once, by the shell. */
export function useGoKeys() {
  const navigate = useNavigate();
  const where = useWhere();
  const go = Object.fromEntries(
    keyed.map((place) => [
      place.key,
      () => {
        const path = destinationPath(place, where());
        if (path) void navigate(path);
      },
    ]),
  );
  useKeySequences({ [PREFIX]: go });
}

/** The card shown a moment after G: every letter that can follow, and where it goes. */
export function GoHint() {
  const waiting = usePendingKey((s) => s.prefix === PREFIX);
  const where = useWhere();
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!waiting) return setShown(false);
    const timer = setTimeout(() => setShown(true), HINT_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  if (!waiting || !shown) return null;
  const at = where();
  const places = keyed.filter((place) => destinationPath(place, at));
  return (
    <div
      role="status"
      aria-label={t("goto.title")}
      className="pointer-events-none fixed bottom-6 left-1/2 z-[60] w-[min(31rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-white/10 bg-inverse px-4 pt-3 pb-3.5 text-inverse-ink shadow-pop animate-pop"
    >
      <p className="flex items-center gap-2 text-xs font-medium">
        <span className="flex w-5 shrink-0 justify-center">
          <Kbd onDark>G</Kbd>
        </span>
        {t("goto.title")}
        {at.project && <span className="ml-auto truncate font-normal opacity-70">{t("goto.project", { project: at.project.name })}</span>}
      </p>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-5 gap-y-1.5 border-t border-white/10 pt-2.5 sm:grid-cols-3">
        {places.map((place) => (
          <li key={place.id} className="flex min-w-0 items-center gap-2 text-sm">
            <span className="flex w-5 shrink-0 justify-center">
              <Kbd onDark>{(place.key ?? "").toUpperCase()}</Kbd>
            </span>
            <span className="min-w-0 truncate">{t(place.label)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
