// Films a page of the real app as an edited piece, with nobody seen
// operating it: the whole app in frame, a page that scrolls itself to what
// comes next, a brief ring on what just changed, captions, and, if asked
// for, a camera that leans a little toward each change.
//
// A headless browser takes a sharp (device pixel ratio 2) screenshot only
// some 16 times a second, too few for smooth movement. So the page is
// filmed in slow motion: everything that moves in it runs SLOW times slower
// than usual (CSS transitions and animations through the DevTools protocol,
// the page's timers through the script `prepare` installs), and one
// screenshot is taken for each frame of the film, at that frame's moment in
// film time, with the film's own movements (scroll, camera) put where they
// are at that moment first. Played back, the app runs at its own speed and
// every movement is exact. What reacts to the server (the live feed, an
// agent's change) arrives SLOW times faster than it would, which is time an
// edit would cut.
//
// The camera is in the page: the app's body is scaled and moved with a CSS
// transform, never below its own size, so no edge shows and text stays sharp.

import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Locator, Page } from "@playwright/test";
import { DESKTOP, here } from "./server.ts";

export const FPS = 30;
const SLOW = 3;

/** Where the camera is: the point of the page in the middle of the frame, and how much it is enlarged. */
interface Camera {
  x: number;
  y: number;
  zoom: number;
}
const REST: Camera = { x: DESKTOP.width / 2, y: DESKTOP.height / 2, zoom: 1 };

/** A named moment of the film, for checking its pacing. */
export interface Beat {
  name: string;
  at: number;
}

/**
 * Makes every page the context opens ready to be filmed: timers slowed with
 * the film, what would distract hidden, and the film's own layer (ring,
 * caption) over the page.
 */
export async function prepare(context: BrowserContext) {
  const font = (await readFile(join(here, "../fonts/instrument-sans-latin.woff2"))).toString("base64");
  await context.addInitScript(
    ({ slow, font }) => {
      // Timers run as slowly as the film, so a toast's stay or a delay in the app lasts as long on screen as it does live.
      const timeout = window.setTimeout.bind(window);
      const interval = window.setInterval.bind(window);
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
        timeout(fn, (ms ?? 0) * slow, ...rest)) as typeof window.setTimeout;
      window.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
        interval(fn, (ms ?? 0) * slow, ...rest)) as typeof window.setInterval;

      const style = document.createElement("style");
      style.textContent = `
        @font-face { font-family: "Film Sans"; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 400 700; }
        html { overflow: hidden; }
        body { transform-origin: 0 0; }
        /* What would distract, and is not what the film is about: the unread
           count that climbs as the agent works, toasts, tooltips, focus rings
           and the text caret. */
        a[href$="/inbox"] > span + span, [aria-label^="Notifications"], [role="tooltip"] { visibility: hidden !important; }
        * { caret-color: transparent !important; }
        *:focus-visible { outline: none !important; --tw-ring-shadow: 0 0 #0000 !important; }
        /* A button the film presses, as a finger would. */
        .film-press { transform: scale(0.96); filter: brightness(0.86); transition: transform 90ms ease-out, filter 90ms ease-out; }
        #film-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
        /* The ring on what just changed: in the app's accent, gone within a moment. */
        .film-ring { position: absolute; border-radius: 10px; opacity: 0;
          box-shadow: 0 0 0 1.5px var(--accent), 0 0 22px 2px color-mix(in srgb, var(--accent) 45%, transparent);
          animation: film-ring 700ms ease-out; }
        @keyframes film-ring { 0% { opacity: 0; } 18% { opacity: 1; } 100% { opacity: 0; } }
        #film-band { position: absolute; left: 0; right: 0; bottom: 0; height: 76px; display: flex; align-items: center; padding: 0 40px;
          background: rgb(8 9 12); transform: translateY(100%); transition: transform 450ms cubic-bezier(0.2, 0.7, 0.2, 1); }
        #film-caption { margin: 0; font: 600 30px/1 "Film Sans", sans-serif; letter-spacing: -0.02em; color: #f5f6fa;
          opacity: 0; transition: opacity 300ms ease; }
        #film-layer.captioned #film-band { transform: none; }
        #film-layer.captioned #film-caption { opacity: 1; transition-delay: 120ms; }
      `;
      const layer = document.createElement("div");
      layer.id = "film-layer";
      layer.innerHTML = '<div id="film-band"><p id="film-caption"></p></div>';
      // On the root, beside the app's body, which the camera moves.
      document.addEventListener("DOMContentLoaded", () => document.documentElement.append(style, layer));
    },
    { slow: SLOW, font },
  );
}

/**
 * Starts filming the page. `lean` is how far the camera may lean in toward a change (1
 * for a camera that never moves). Every frame is written to `dir` as
 * 00000.png, 00001.png… (a frame like the one before it is a link to that
 * one). Everything the returned film does is timed in film time.
 */
export async function startFilm(page: Page, dir: string, { lean }: { lean: number }) {
  await mkdir(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 / SLOW });
  // Outside the moved body the page shows the app's own background, so no edge ever shows.
  await page.evaluate(() => {
    document.documentElement.style.background = getComputedStyle(document.body).backgroundColor;
  });

  const start = performance.now();
  /** Film time now, in ms. */
  const now = () => (performance.now() - start) / SLOW;
  /** Waits until the film's clock reads `at`. */
  const until = async (at: number) => {
    const wait = (at - now()) * SLOW;
    if (wait > 1) await new Promise((done) => setTimeout(done, wait));
  };

  // The film's own movements, in order; where each is at any moment follows from them.
  const camera: Move<Camera>[] = [{ from: REST, to: REST, start: 0, ms: 0 }];
  const scroll: Move<number>[] = [];
  const at = <T>(moves: Move<T>[], time: number) => moves.findLast((m) => m.start <= time);

  const beats: Beat[] = [];
  const writes: Promise<void>[] = [];
  let filming = true;
  let late = 0;
  const shooting = (async () => {
    const seen = new Map<string, string>();
    for (let n = 0; filming; n++) {
      // One screenshot per frame of the film, taken at that frame's moment, with the camera and the scroll where they are then.
      const time = (n * 1000) / FPS;
      await until(time);
      if (now() > time + 1000 / FPS) late++;
      const view = between(at(camera, time) ?? camera[0], time, mixCamera);
      const move = at(scroll, time);
      // The scroll is the film's only while it moves; otherwise it is left to the app.
      const top = move && time <= move.start + move.ms + 1000 / FPS ? between(move, time, mixNumber) : null;
      await cdp.send("Runtime.evaluate", { expression: place(view, top) });
      const shot = await capture(cdp);
      const name = `${String(n).padStart(5, "0")}.png`;
      const hash = createHash("sha1").update(shot).digest("hex");
      const same = seen.get(hash);
      if (same) writes.push(symlink(same, join(dir, name)));
      else {
        seen.set(hash, name);
        writes.push(writeFile(join(dir, name), Buffer.from(shot, "base64")));
      }
    }
  })();

  const film = {
    /** Lets `ms` of film time pass. */
    hold: (ms: number) => until(now() + ms),
    /** Marks a moment, for the pacing report. */
    beat(name: string) {
      beats.push({ name, at: now() });
    },
    /**
     * Starts the camera leaning in toward `target` over `ms`, or back to the
     * whole app with null, and returns at once: a lean lasts as long as a beat.
     */
    async lean(target: Locator | null, ms: number) {
      const begin = now();
      const from = between(at(camera, begin) ?? camera[0], begin, mixCamera);
      let to = REST;
      if (target && lean > 1) {
        const { x, y } = await middleOf(target);
        // A little of the way toward the change: the whole app stays in frame, the eye is drawn.
        const toward = 0.4;
        to = { x: REST.x + (x - REST.x) * toward, y: REST.y + (y - REST.y) * toward, zoom: lean };
      }
      camera.push({ from, to, start: begin, ms });
    },
    /**
     * Scrolls the page that holds `target` until all of it is in view with
     * room around, eased over `ms`; does nothing when it already is.
     */
    async scrollTo(target: Locator, ms: number) {
      await target.waitFor();
      const { from, to } = await target.evaluate((el) => {
        let scroller = el.parentElement;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY)))
          scroller = scroller.parentElement;
        if (!scroller) return { from: 0, to: 0 };
        // The film moves this one from now on (see place).
        (window as unknown as { filmScroller: Element }).filmScroller = scroller;
        const room = 32;
        const box = el.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        let by = Math.max(0, box.bottom + room - view.bottom);
        by = Math.min(by, box.top - room - view.top);
        const to = Math.min(scroller.scrollHeight - scroller.clientHeight, Math.max(0, scroller.scrollTop + by));
        return { from: scroller.scrollTop, to };
      });
      if (Math.abs(to - from) < 1) return;
      const begin = now();
      scroll.push({ from, to, start: begin, ms });
      await until(begin + ms);
    },
    /** Puts a brief ring in the app's accent around `target`, which just changed. */
    async ring(target: Locator) {
      await target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const ring = document.createElement("div");
        ring.className = "film-ring";
        const pad = 6;
        Object.assign(ring.style, {
          left: `${box.left - pad}px`,
          top: `${box.top - pad}px`,
          width: `${box.width + 2 * pad}px`,
          height: `${box.height + 2 * pad}px`,
        });
        ring.addEventListener("animationend", () => ring.remove());
        document.getElementById("film-layer")?.prepend(ring);
      });
    },
    /** Shows a caption on a dark band at the bottom of the frame (or takes it away, with null). */
    async caption(text: string | null) {
      await page.evaluate((text) => {
        const layer = document.getElementById("film-layer");
        const caption = document.getElementById("film-caption");
        if (!layer || !caption) return;
        if (text) caption.textContent = text;
        layer.classList.toggle("captioned", !!text);
      }, text);
    },
    /**
     * Presses a button as a finger would, with no pointer on screen: it dips
     * for a moment, then the app gets a real click.
     */
    async press(button: Locator) {
      await button.evaluate((el) => el.classList.add("film-press"));
      await film.hold(140);
      await button.evaluate((el) => {
        el.classList.remove("film-press");
        (el as HTMLElement).click();
      });
    },
    /** Stops filming and gives the beats and the film's length, once every frame is on disk. */
    async stop() {
      filming = false;
      await shooting;
      await Promise.all(writes);
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
      await cdp.detach();
      if (late) console.warn(`${late} frames were taken late: the app may move unevenly there`);
      return { beats, length: now() };
    },
  };
  return film;
}

export type Film = Awaited<ReturnType<typeof startFilm>>;

interface Move<T> {
  from: T;
  to: T;
  start: number;
  ms: number;
}

/** Slow at both ends: a lean or a scroll that starts and settles without a jolt. */
const ease = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;
const mixNumber = (from: number, to: number, t: number) => from + (to - from) * t;
const mixCamera = (from: Camera, to: Camera, t: number) => ({
  x: mixNumber(from.x, to.x, t),
  y: mixNumber(from.y, to.y, t),
  zoom: mixNumber(from.zoom, to.zoom, t),
});

function between<T>(move: Move<T>, time: number, mix: (from: T, to: T, t: number) => T) {
  const done = move.ms ? Math.min(1, Math.max(0, (time - move.start) / move.ms)) : 1;
  return mix(move.from, move.to, ease(done));
}

/** The middle of an element on the page itself, whatever the camera is doing to the body. */
function middleOf(target: Locator) {
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    const scale = body.width / document.body.offsetWidth;
    return { x: ((box.left + box.right) / 2 - body.left) / scale, y: ((box.top + box.bottom) / 2 - body.top) / scale };
  });
}

/** The script that puts the camera at `camera`, kept inside the page so its edge never shows, and the page's scroll at `top`. */
function place(camera: Camera, top: number | null) {
  const { width, height } = DESKTOP;
  const { zoom } = camera;
  const x = Math.min(0, Math.max(width - width * zoom, width / 2 - camera.x * zoom));
  const y = Math.min(0, Math.max(height - height * zoom, height / 2 - camera.y * zoom));
  const scroll = top === null ? "" : `if (window.filmScroller) window.filmScroller.scrollTop = ${top.toFixed(2)};`;
  return `document.body.style.transform = "translate(${x.toFixed(3)}px, ${y.toFixed(3)}px) scale(${zoom.toFixed(5)})"; ${scroll}`;
}

async function capture(cdp: CDPSession) {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    optimizeForSpeed: true,
    clip: { x: 0, y: 0, ...DESKTOP, scale: 2 },
  });
  return data;
}
