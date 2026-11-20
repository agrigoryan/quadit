// Controls drawn on the dark compare stage: a quiet button that reads on
// black in both themes, and the layout, pixel and zoom controls in the header.

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Columns3, Grid2x2, Minus, Plus, Square } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { Tooltip } from "@/ui/tooltip";
import type { Compare } from "@/decisions/compare-state";

interface StageButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Shown as a tooltip, with the shortcut. Icon-only buttons also need aria-label. */
  tip?: string;
  hint?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function StageButton({ tip, hint, className, children, ...rest }: StageButtonProps) {
  const button = (
    <button
      type="button"
      className={cx(
        "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-inverse-ink/80",
        "hover:bg-white/10 hover:text-inverse-ink focus-visible:outline-white disabled:pointer-events-none disabled:opacity-40",
        "aria-pressed:bg-white/15 aria-pressed:text-inverse-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tip ? (
    <Tooltip label={tip} hint={hint}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/** Side by side, or one at a time. L switches between them. */
export function LayoutSwitch({ c }: { c: Compare }) {
  const layouts = [
    { layout: "side-by-side", name: t("compare.sideBySide"), icon: Columns3 },
    { layout: "one", name: t("compare.oneAtATime"), icon: Square },
  ] as const;
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a set of buttons, not form fields: <fieldset> is for those
    <div role="group" aria-label={t("compare.layout")} className="mr-1 flex items-center">
      {layouts.map(({ layout, name, icon: Icon }) => (
        <StageButton
          key={layout}
          tip={name}
          hint="L"
          aria-label={name}
          aria-pressed={c.layout === layout}
          onClick={() => c.setLayout(layout)}
        >
          <Icon className="size-4" aria-hidden />
        </StageButton>
      ))}
    </div>
  );
}

/** A switch for hard pixel edges, for sprite art. */
export function PixelToggle({ c, compact }: { c: Compare; compact?: boolean }) {
  return (
    <StageButton
      tip={t("compare.pixelHint")}
      hint="P"
      aria-label={t("compare.pixel")}
      aria-pressed={c.pixelated}
      onClick={() => c.setPixelated(!c.pixelated)}
      className={compact ? "size-10! px-0!" : undefined}
    >
      <Grid2x2 className="size-4" aria-hidden />
      {!compact && t("compare.pixel")}
    </StageButton>
  );
}

/** − 125% +, Fit, 100%. */
export function ZoomControls({ c }: { c: Compare }) {
  const { zoom } = c;
  const percent = Math.round(c.fit * zoom.view.k * 100);
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a set of buttons, not form fields: <fieldset> is for those
    <div role="group" aria-label={t("compare.zoom")} className="flex items-center">
      <StageButton
        tip={t("compare.zoomOut")}
        hint="−"
        aria-label={t("compare.zoomOut")}
        onClick={() => zoom.zoomBy(1 / 1.25)}
      >
        <Minus className="size-4" aria-hidden />
      </StageButton>
      <output
        aria-label={t("compare.zoomNow", { n: percent })}
        className="w-12 text-center text-xs text-inverse-ink tnum"
      >
        {percent}%
      </output>
      <StageButton
        tip={t("compare.zoomIn")}
        hint="+"
        aria-label={t("compare.zoomIn")}
        onClick={() => zoom.zoomBy(1.25)}
      >
        <Plus className="size-4" aria-hidden />
      </StageButton>
      <StageButton tip={t("compare.fitHint")} hint="0" aria-pressed={zoom.isFit} onClick={zoom.fit} className="ml-1">
        {t("compare.fit")}
      </StageButton>
      <StageButton tip={t("compare.actualHint")} aria-pressed={percent === 100} onClick={zoom.actualSize}>
        100%
      </StageButton>
    </div>
  );
}
