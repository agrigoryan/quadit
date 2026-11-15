import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cx } from "@/lib/cx";
import { Tooltip } from "@/ui/tooltip";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-quiet" | "move";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none " +
  "transition-colors duration-100 disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-hover",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-hover shadow-card",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink",
  danger: "bg-danger text-white hover:brightness-95",
  // For a destructive action that sits beside ordinary ones.
  "danger-quiet": "bg-surface text-danger border border-line-strong hover:bg-danger-soft shadow-card",
  // The one loud button: answering a question that waits on you.
  move: "bg-move text-move-ink hover:brightness-95 font-semibold",
};

const sizes: Record<Size, string> = {
  sm: "h-6 px-2 text-xs",
  md: "h-7 px-2.5 text-sm",
  lg: "h-10 px-4 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", size = "md", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx(base, variants[variant], sizes[size], className)} {...rest} />;
}

const iconSizes: Record<Size, string> = { sm: "size-6", md: "size-7", lg: "size-10" };

export interface IconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  /** Said by screen readers and shown as the tooltip. */
  label: string;
  /** A shortcut to show in the tooltip. */
  hint?: string;
  children: ReactNode;
}

export function IconButton({
  label,
  hint,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label} hint={hint}>
      <button
        type={type}
        aria-label={label}
        className={cx(base, variants[variant], iconSizes[size], "px-0", className)}
        {...rest}
      />
    </Tooltip>
  );
}
