import { useState } from "react";
import { t } from "@/lib/i18n";
import { MOD } from "@/hooks/hotkeys";
import { Button } from "@/ui/button";
import { MentionTextarea } from "@/ui/mention-textarea";

interface Props {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}

/** A small box for a comment or a reply: Markdown, @ to mention, Cmd/Ctrl-Enter to send. */
export function Composer({ placeholder, submitLabel, onSubmit, onCancel, autoFocus }: Props) {
  const [body, setBody] = useState("");
  const [active, setActive] = useState(!!autoFocus);
  const send = () => {
    const text = body.trim();
    if (!text) return;
    onSubmit(text);
    setBody("");
    setActive(false);
  };
  return (
    <div>
      <MentionTextarea
        value={body}
        onChange={setBody}
        onSubmit={send}
        autoFocus={autoFocus}
        rows={active ? 2 : 1}
        placeholder={placeholder}
        aria-label={placeholder}
        onFocus={() => setActive(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
        className="text-sm"
      />
      {(active || body) && (
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <span className="mr-auto text-2xs text-ink-3">{t("docs.comment.sendHint", { mod: MOD })}</span>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={!body.trim()} onClick={send}>
            {submitLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
