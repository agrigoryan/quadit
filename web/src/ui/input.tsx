import { type InputHTMLAttributes, type Ref, type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";
import { cx } from "@/lib/cx";
import { useFieldControl } from "@/ui/form";

const field =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink outline-none transition-colors " +
  "hover:border-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
}

export function Input({ className, ...rest }: InputProps) {
  return <input className={cx(field, "h-8", className)} {...useFieldControl(rest.id)} {...rest} />;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with the text instead of scrolling. */
  autoGrow?: boolean;
  /** No border or padding: for text edited in place. */
  bare?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ className, autoGrow = false, bare = false, ref, value, ...rest }: TextareaProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const described = useFieldControl(rest.id);

  useLayoutEffect(() => {
    const el = own.current;
    if (!el || !autoGrow) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [autoGrow, value]);

  return (
    <textarea
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      value={value}
      className={cx(
        bare ? "w-full resize-none bg-transparent text-ink outline-none" : cx(field, "py-1.5 leading-5"),
        autoGrow && "resize-none overflow-hidden",
        className,
      )}
      {...described}
      {...rest}
    />
  );
}
