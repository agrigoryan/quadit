// The small card about what a mention in text names (a task: ui/task-mention.tsx;
// a page: ui/page-mention.tsx). It shows when a pointer rests on the
// mention, or the keyboard reaches it, and the mention is then described by
// it; a click on the mention shuts it.

import { HoverCard } from "radix-ui";
import { type ReactElement, type ReactNode, useId, useRef, useState } from "react";

/** How long the pointer rests on a mention before its card shows, and lingers after it leaves. */
const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 150;

/**
 * True when a key was pressed since the pointer last moved. Text typed
 * around a mention moves it under a mouse that rests, and the browser takes
 * that for the pointer coming over it: no card opens for that. Written by
 * the two listeners below, which last as long as the page.
 */
let keysSinceMove = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (keysSinceMove = true), true);
  document.addEventListener("pointermove", () => (keysSinceMove = false), true);
}

interface Props {
  /** The mention: a link or a control, which takes the props of the card's trigger. */
  mention: ReactElement;
  /** What the card says. It is drawn only while the card is open. */
  children: ReactNode;
}

export function MentionCard({ mention, children }: Props) {
  const [open, setOpen] = useState(false);
  const cardId = useId();
  // Whether the mention has the keyboard's focus, which opens the card whatever was typed before.
  const keyboardFocus = useRef(false);
  // Whether the card was kept shut for keys pressed, so the pointer's next move over the mention opens it.
  const heldBack = useRef(false);
  return (
    <HoverCard.Root
      open={open}
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
      onOpenChange={(next) => {
        if (next && keysSinceMove && !keyboardFocus.current) {
          heldBack.current = true;
          return;
        }
        setOpen(next);
      }}
    >
      <HoverCard.Trigger
        asChild
        aria-describedby={open ? cardId : undefined}
        // A tap or a click focuses a link too; only the keyboard's focus is a reason to show the card.
        onFocus={(e) => {
          keyboardFocus.current = e.currentTarget.matches(":focus-visible");
          if (!keyboardFocus.current) e.preventDefault();
        }}
        onBlur={() => (keyboardFocus.current = false)}
        onPointerMove={() => {
          if (!heldBack.current) return;
          heldBack.current = false;
          setOpen(true);
        }}
        onPointerLeave={() => (heldBack.current = false)}
        onClick={() => setOpen(false)}
      >
        {mention}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          id={cardId}
          role="tooltip"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-surface p-3 text-ink shadow-pop outline-none animate-pop"
        >
          {children}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
