// One zoom and pan shared by every pane of the compare view. The view is a
// scale relative to "fit" and an offset as a fraction of the pane, so the
// same numbers put the same part of every picture under the same spot.
// Wheel and pinch zoom around the pointer, a drag pans, a double click (or
// double tap) switches between fit and actual size.

import { type PointerEvent, type MouseEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface View {
  /** 1 is "fit the pane". */
  k: number;
  /** Offset from the centre, as a fraction of the pane's width and height. */
  x: number;
  y: number;
}

export const FIT: View = { k: 1, x: 0, y: 0 };

const within = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

type Point = { x: number; y: number };

export interface Zoom {
  view: View;
  isFit: boolean;
  /** Zooms about the middle of the pane: 1.25 is one step in. */
  zoomBy: (factor: number) => void;
  fit: () => void;
  /** Shows the focused picture at one screen pixel per picture pixel. */
  actualSize: () => void;
  /** Spread on each pane's viewport. */
  bind: {
    ref: (el: HTMLElement | null) => (() => void) | undefined;
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onDoubleClick: (e: MouseEvent<HTMLElement>) => void;
  };
}

/** `actual` is the scale at which the focused picture is at its real size. */
export function useSharedZoom(actual: number): Zoom {
  const [view, setView] = useState<View>(FIT);
  const actualRef = useRef(actual);
  useLayoutEffect(() => {
    actualRef.current = actual;
  });
  const pointers = useRef(new Map<number, Point>());
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const travelled = useRef(0);
  const touch = useRef(false);

  /** Keeps the scale in range and the picture over the pane. */
  const settle = useCallback((v: View): View => {
    const a = actualRef.current;
    const k = within(v.k, Math.min(1, a / 2), Math.max(8, a * 8));
    const reach = Math.max(0, (k - 1) / 2);
    return { k, x: within(v.x, -reach, reach), y: within(v.y, -reach, reach) };
  }, []);

  /** Goes to scale k, keeping the point at (px, py) — fractions from the centre — where it is. */
  const scaleTo = useCallback(
    (v: View, wanted: number, px: number, py: number): View => {
      const k = settle({ ...v, k: wanted }).k;
      const r = k / v.k;
      return settle({ k, x: px - (px - v.x) * r, y: py - (py - v.y) * r });
    },
    [settle],
  );

  const bind = useMemo<Zoom["bind"]>(() => {
    const spot = (rect: DOMRect, clientX: number, clientY: number): [number, number] => [
      (clientX - rect.left) / rect.width - 0.5,
      (clientY - rect.top) / rect.height - 0.5,
    ];
    const zoomAt = (rect: DOMRect, clientX: number, clientY: number, factor: number) =>
      setView((v) => scaleTo(v, v.k * factor, ...spot(rect, clientX, clientY)));
    const toggleAt = (rect: DOMRect, clientX: number, clientY: number) =>
      setView((v) => {
        if (v.k !== 1 || v.x !== 0 || v.y !== 0) return FIT;
        // When actual size is what "fit" already shows, go in to double.
        const target = Math.abs(actualRef.current - 1) < 0.05 ? 2 : actualRef.current;
        return scaleTo(v, target, ...spot(rect, clientX, clientY));
      });
    const forget = (e: PointerEvent<HTMLElement>) => pointers.current.delete(e.pointerId);

    return {
      ref: (el) => {
        if (!el) return undefined;
        const onWheel = (e: WheelEvent) => {
          e.preventDefault();
          const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
          zoomAt(el.getBoundingClientRect(), e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
      },
      onPointerDown: (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        touch.current = e.pointerType === "touch";
        // Keep the drag when it leaves the pane. A pointer that is already gone cannot be held.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          return;
        }
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.current.size === 1) travelled.current = 0;
      },
      onPointerMove: (e) => {
        const before = pointers.current.get(e.pointerId);
        if (!before) return;
        const now = { x: e.clientX, y: e.clientY };
        const rect = e.currentTarget.getBoundingClientRect();
        pointers.current.set(e.pointerId, now);
        travelled.current += Math.abs(now.x - before.x) + Math.abs(now.y - before.y);
        const other = [...pointers.current].find(([id]) => id !== e.pointerId)?.[1];
        if (other) {
          // Two fingers: the change in their distance is the zoom, about the point between them.
          const was = Math.hypot(before.x - other.x, before.y - other.y);
          const is = Math.hypot(now.x - other.x, now.y - other.y);
          if (was > 0) zoomAt(rect, (now.x + other.x) / 2, (now.y + other.y) / 2, is / was);
          return;
        }
        const dx = (now.x - before.x) / rect.width;
        const dy = (now.y - before.y) / rect.height;
        setView((v) => settle({ k: v.k, x: v.x + dx, y: v.y + dy }));
      },
      onPointerUp: (e) => {
        forget(e);
        if (e.pointerType !== "touch" || travelled.current > 12) return;
        const tap = { at: e.timeStamp, x: e.clientX, y: e.clientY };
        const last = lastTap.current;
        if (last && tap.at - last.at < 320 && Math.hypot(tap.x - last.x, tap.y - last.y) < 32) {
          lastTap.current = null;
          toggleAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
        } else {
          lastTap.current = tap;
        }
      },
      onPointerCancel: forget,
      // A double tap is handled above, as two taps.
      onDoubleClick: (e) => {
        if (!touch.current) toggleAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
      },
    };
  }, [settle, scaleTo]);

  return {
    view,
    isFit: view.k === 1 && view.x === 0 && view.y === 0,
    zoomBy: (factor) => setView((v) => scaleTo(v, v.k * factor, 0, 0)),
    fit: () => setView(FIT),
    actualSize: () => setView((v) => scaleTo(v, actualRef.current, 0, 0)),
    bind,
  };
}
