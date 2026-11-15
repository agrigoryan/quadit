import { type ClipboardEvent, type KeyboardEvent, useRef } from "react";
import { X } from "lucide-react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { addHosts } from "@/settings/secrets/data";
import { useFieldControl } from "@/ui/form";

interface Props {
  id: string;
  value: string[];
  onChange: (hosts: string[]) => void;
  /** What is typed and not yet a chip. The form holds it so that Save can take it too. */
  draft: string;
  onDraft: (text: string) => void;
  /** Called with what is wrong with the text, or "" once it is fine. */
  onError: (message: string) => void;
}

/**
 * Hosts as chips: type one and press Enter or comma. Backspace in the empty
 * box takes the last one off. Its FormField's hint and error describe it.
 */
export function HostInput({ id, value, onChange, draft, onDraft, onError }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const field = useFieldControl(id);
  const invalid = field["aria-invalid"];

  function commit(text: string): boolean {
    if (!text.trim()) return true;
    const out = addHosts(value, text);
    if ("bad" in out) {
      onError(t("secrets.hostInvalid", { host: out.bad }));
      return false;
    }
    onChange(out.hosts);
    onDraft("");
    onError("");
    return true;
  }

  function onText(text: string) {
    // A comma that arrives as text (a phone's keyboard sends no key for it) ends the host too.
    if (text.includes(",")) {
      if (!commit(text)) onDraft(text.replace(/,/g, " ").trim());
      return;
    }
    onDraft(text);
    onError("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      // Enter in the empty box is the form's: it saves.
      if (e.key === "Enter" && !draft.trim()) return;
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    // A pasted list becomes chips at once; one host is left to be finished by hand.
    if (!/[\s,]/.test(text.trim())) return;
    e.preventDefault();
    if (!commit(`${draft} ${text}`)) onDraft(`${draft}${text}`.trim());
  }

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a click beside the chips puts the caret in the box; the keyboard reaches the box itself
    <div
      onClick={() => input.current?.focus()}
      className={cx(
        "flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border bg-surface px-1.5 py-1 transition-colors",
        "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25",
        invalid ? "border-danger" : "border-line-strong hover:border-ink-3",
      )}
    >
      {value.map((host) => (
        <span
          key={host}
          className="inline-flex h-5.5 max-w-full items-center gap-0.5 rounded-sm border border-line bg-sunken pr-0.5 pl-1.5 font-mono text-xs text-ink"
        >
          <span className="truncate">{host}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((h) => h !== host));
            }}
            aria-label={t("secrets.hostRemove", { host })}
            className="flex size-4.5 shrink-0 items-center justify-center rounded-xs text-ink-3 hover:bg-press hover:text-ink"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        value={draft}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? t("secrets.hostsPlaceholder") : undefined}
        {...field}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        inputMode="url"
        enterKeyHint="done"
        className="h-5.5 min-w-24 flex-1 bg-transparent px-1 font-mono text-xs text-ink outline-none placeholder:font-sans placeholder:text-sm placeholder:text-ink-3"
      />
    </div>
  );
}
