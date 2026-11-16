// The app's two-key sequences. There is one listener for them all
// (hooks/key-sequence.ts: a second would undo the first's), so every
// sequence is here: G then a letter goes to a place (G I the inbox, G M My
// work, G T the tasks of the project in view; the places are the table in
// shell/destinations.tsx), and, while a task that may be changed is open,
// M then a letter relates it to another (detail/relation-keys.ts). A moment
// after the first key, a small card lists what can follow.

import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useKeySequences, usePendingKey } from "@/hooks/key-sequence";
import { useStore } from "@/data/store";
import { useDelayedFlag } from "@/hooks/use-delayed-flag";
import { RELATION_KEYS, useRelationKeys } from "@/detail/relation-keys";
import { DESTINATIONS, destinationPath, listedName, type Where } from "@/shell/destinations";
import { projectInView } from "@/nav/project-in-view";
import { Kbd } from "@/ui/kbd";

const GO = "g";
const RELATE = "m";
/** Someone who knows the letter has typed it by now: the card is for those who paused. */
const HINT_AFTER_MS = 250;

const keyed = DESTINATIONS.filter((place) => place.key);

/** Where the places are, for the page that is showing now. */
function useWhere(): () => Where {
  const location = useLocation();
  return () => {
    const { slug, user } = useStore.getState();
    return { slug, project: projectInView(location), installAdmin: !!user?.is_admin };
  };
}

/** Turns the sequences on. Called once, by the shell. */
export function useSequences() {
  const navigate = useNavigate();
  const where = useWhere();
  const relating = useRelationKeys((s) => s.relate !== null);
  const go = Object.fromEntries(
    keyed.map((place) => [
      place.key,
      () => {
        const path = destinationPath(place, where());
        if (path) void navigate(path);
      },
    ]),
  );
  const relate = Object.fromEntries(
    RELATION_KEYS.map(({ key, type }) => [key, () => useRelationKeys.getState().relate?.(type)]),
  );
  useKeySequences({ [GO]: go, ...(relating && { [RELATE]: relate }) });
}

/** The card shown a moment after G or M: every key that can follow, and what it does. */
export function SequenceHint() {
  const prefix = usePendingKey((s) => s.prefix);
  const shown = useDelayedFlag(prefix !== null, HINT_AFTER_MS);
  const where = useWhere();
  if (!shown) return null;
  if (prefix === RELATE)
    return (
      <KeyCard
        prefix="M"
        title={t("relate.title")}
        keys={RELATION_KEYS.map(({ key, what }) => ({ key, label: t(what) }))}
        wide
      />
    );
  if (prefix !== GO) return null;
  const at = where();
  return (
    <KeyCard
      prefix="G"
      title={t("goto.title")}
      aside={at.project && t("goto.project", { project: at.project.name })}
      keys={keyed
        .filter((place) => destinationPath(place, at))
        .map((place) => ({ key: place.key ?? "", label: t(listedName(place)) }))}
    />
  );
}

interface KeyCardProps {
  /** The key pressed, as its cap shows it. */
  prefix: string;
  title: string;
  /** Said at the right of the title line. */
  aside?: ReactNode;
  /** What can follow, in order. */
  keys: { key: string; label: string }[];
  /** Two columns at most, for labels too long for three. */
  wide?: boolean;
}

function KeyCard({ prefix, title, aside, keys, wide }: KeyCardProps) {
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the card holds a heading line and a list, which an <output> may not hold
      role="status"
      aria-label={title}
      className="pointer-events-none fixed bottom-6 left-1/2 z-[60] w-[min(31rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-white/10 bg-inverse px-4 pt-3 pb-3.5 text-inverse-ink shadow-pop animate-pop"
    >
      <p className="flex items-center gap-2 text-xs font-medium">
        <span className="flex w-5 shrink-0 justify-center">
          <Kbd onDark>{prefix}</Kbd>
        </span>
        {title}
        {aside && <span className="ml-auto truncate font-normal opacity-70">{aside}</span>}
      </p>
      <ul
        className={cx(
          "mt-2.5 grid grid-cols-2 gap-x-5 gap-y-1.5 border-t border-white/10 pt-2.5",
          !wide && "sm:grid-cols-3",
        )}
      >
        {keys.map(({ key, label }) => (
          <li key={key} className="flex min-w-0 items-center gap-2 text-sm">
            <span className="flex w-5 shrink-0 justify-center">
              <Kbd onDark>{key.toUpperCase()}</Kbd>
            </span>
            <span className="min-w-0 truncate">{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
