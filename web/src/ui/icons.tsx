// The app's own marks. Statuses are drawn as "quads" (rounded squares), one
// shape per category, so a column of them reads at a glance and looks like
// nothing but Quadit.

import { cx } from "@/lib/cx";
import { tMaybe } from "@/lib/i18n";
import type { Category } from "@/types/core";

interface IconProps {
  className?: string;
  /** Said by screen readers. Leave out when the name is written next to the icon. */
  title?: string;
}

function Svg({ className, title, children, size = 14 }: IconProps & { children: React.ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 14 14"
      width={size}
      height={size}
      fill="none"
      className={cx("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {children}
    </svg>
  );
}

const frame = { x: 1.75, y: 1.75, width: 10.5, height: 10.5, rx: 3 };

/** One of six shapes, by status category. */
export function StatusIcon({ category, className, title }: IconProps & { category: Category }) {
  const color = `var(--cat-${category})`;
  const label = title ?? undefined;
  switch (category) {
    case "backlog":
      return (
        <Svg className={className} title={label}>
          <rect {...frame} stroke={color} strokeWidth="1.5" strokeDasharray="2.1 2.1" strokeLinecap="round" />
        </Svg>
      );
    case "unstarted":
      return (
        <Svg className={className} title={label}>
          <rect {...frame} stroke={color} strokeWidth="1.5" />
        </Svg>
      );
    case "started":
      return (
        <Svg className={className} title={label}>
          <rect {...frame} stroke={color} strokeWidth="1.5" />
          <path d="M4.5 4.5H7v5H4.5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5Z" fill={color} />
        </Svg>
      );
    case "waiting":
      return (
        <Svg className={className} title={label}>
          <rect {...frame} stroke={color} strokeWidth="1.5" />
          <rect x="4.6" y="4.5" width="1.6" height="5" rx=".8" fill={color} />
          <rect x="7.8" y="4.5" width="1.6" height="5" rx=".8" fill={color} />
        </Svg>
      );
    case "done":
      return (
        <Svg className={className} title={label}>
          <rect x="1" y="1" width="12" height="12" rx="3.5" fill={color} />
          <path
            d="m4.2 7.2 1.9 1.9 3.7-4"
            stroke="var(--surface)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
    case "canceled":
      return (
        <Svg className={className} title={label}>
          <rect x="1" y="1" width="12" height="12" rx="3.5" fill={color} />
          <path d="m4.8 4.8 4.4 4.4m0-4.4L4.8 9.2" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" />
        </Svg>
      );
  }
}

/** 0 none, 1 urgent, 2 high, 3 medium, 4 low: more bars, more pressing. */
export function PriorityIcon({ priority, className, title }: IconProps & { priority: number }) {
  const label = title ?? tMaybe(`priority.${priority}`);
  if (priority === 1) {
    return (
      <Svg className={className} title={label}>
        <rect x="1" y="1" width="12" height="12" rx="3.5" fill="var(--danger)" />
        <path d="M7 3.8v3.6" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="7" cy="9.9" r=".95" fill="#fff" />
      </Svg>
    );
  }
  if (priority < 1 || priority > 4) {
    return (
      <Svg className={className} title={label}>
        {[3, 7, 11].map((x) => (
          <rect key={x} x={x - 1} y="6.25" width="2" height="1.5" rx=".75" fill="var(--ink-3)" />
        ))}
      </Svg>
    );
  }
  const filled = 5 - priority; // high 3, medium 2, low 1
  return (
    <Svg className={className} title={label}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1.5 + i * 4}
          y={8.5 - i * 3}
          width="3"
          height={4 + i * 3}
          rx="1"
          fill={i < filled ? "var(--ink-2)" : "var(--line-strong)"}
        />
      ))}
    </Svg>
  );
}

/** The Quadit mark: four options, one picked. */
export function QuadMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} className={cx("shrink-0", className)} aria-hidden>
      <rect width="20" height="20" rx="5" fill="var(--ink)" />
      <g stroke="var(--surface)" strokeWidth="1.2" opacity=".6" fill="none">
        <rect x="4.6" y="4.6" width="4.6" height="4.6" rx="1.2" />
        <rect x="4.6" y="10.8" width="4.6" height="4.6" rx="1.2" />
        <rect x="10.8" y="10.8" width="4.6" height="4.6" rx="1.2" />
      </g>
      <rect x="10.4" y="4.2" width="5.4" height="5.4" rx="1.4" fill="var(--move)" />
    </svg>
  );
}

/** An open question on a task. Filled when it is yours to answer. */
export function DecisionMark({ mine, className, title }: IconProps & { mine: boolean }) {
  return (
    <Svg className={className} title={title}>
      <rect
        x="1"
        y="1"
        width="12"
        height="12"
        rx="3.5"
        fill={mine ? "var(--move)" : "none"}
        stroke={mine ? "none" : "var(--ink-3)"}
        strokeWidth="1.3"
      />
      <path
        d="M5.3 5.6c0-1 .8-1.7 1.8-1.7s1.7.7 1.7 1.6c0 1.3-1.7 1.3-1.7 2.6"
        stroke={mine ? "var(--move-ink)" : "var(--ink-2)"}
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="7.1" cy="10.1" r=".85" fill={mine ? "var(--move-ink)" : "var(--ink-2)"} />
    </Svg>
  );
}
