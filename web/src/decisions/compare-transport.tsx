// One play button and one scrubber for every video on the compare stage.
// The longest video leads; the others are started, stopped and moved with
// it, and pulled back when they drift.

import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import { t } from "@/lib/i18n";
import { clockTime } from "@/lib/time";
import type { Compare } from "@/decisions/compare-state";
import { StageButton } from "@/decisions/stage-ui";

const lengthOf = (v: HTMLVideoElement) => (Number.isFinite(v.duration) ? v.duration : 0);

function leaderOf(videos: HTMLVideoElement[]): HTMLVideoElement | undefined {
  return videos.reduce<HTMLVideoElement | undefined>(
    (best, v) => (!best || lengthOf(v) > lengthOf(best) ? v : best),
    undefined,
  );
}

/** Puts every video at the same moment (a shorter one wraps around). */
function seekAll(videos: HTMLVideoElement[], seconds: number) {
  for (const v of videos) {
    const length = lengthOf(v);
    if (length > 0) v.currentTime = seconds >= length ? seconds % length : seconds;
  }
}

export function Transport({ c }: { c: Compare }) {
  const { playing, videos } = c;
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);

  // Each frame: read the leader's clock, and make every video on stage do
  // what the button says. Videos come and go as the viewer pages and steps.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const all = videos();
      const leader = leaderOf(all);
      if (leader) {
        setTime(leader.currentTime);
        setLength(lengthOf(leader));
        for (const v of all) {
          if (playing && v.paused) {
            if (v !== leader && lengthOf(v) > 0) v.currentTime = leader.currentTime % lengthOf(v);
            void v.play().catch(() => {});
          } else if (!playing && !v.paused) {
            v.pause();
          } else if (playing && v !== leader && Math.abs(lengthOf(v) - lengthOf(leader)) < 0.05) {
            const drift = Math.abs(v.currentTime - leader.currentTime);
            // Far apart only for the instant one has looped and the other has not: leave that alone.
            if (drift > 0.12 && drift < lengthOf(leader) - 0.25) v.currentTime = leader.currentTime;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, videos]);

  return (
    <div
      role="group"
      aria-label={t("compare.transport")}
      className="flex h-11 shrink-0 items-center gap-2 border-t border-white/10 bg-inverse px-3"
    >
      <StageButton
        tip={playing ? t("compare.pause") : t("compare.play")}
        hint="Space"
        aria-label={playing ? t("compare.pause") : t("compare.play")}
        onClick={() => c.setPlaying(!playing)}
        className="max-sm:size-10"
      >
        {playing ? (
          <Pause className="size-4 fill-current" aria-hidden />
        ) : (
          <Play className="size-4 fill-current" aria-hidden />
        )}
      </StageButton>
      <input
        type="range"
        min={0}
        max={length || 1}
        step={0.01}
        value={Math.min(time, length || 1)}
        aria-label={t("compare.scrub")}
        aria-valuetext={clockTime(time)}
        onChange={(e) => {
          const seconds = Number(e.target.value);
          seekAll(videos(), seconds);
          setTime(seconds);
        }}
        className="h-8 min-w-0 flex-1 cursor-pointer accent-inverse-ink"
      />
      <span className="shrink-0 text-xs text-inverse-ink tnum">
        {clockTime(time)} / {clockTime(length)}
      </span>
    </div>
  );
}
