// Choosing how a person or an agent is pictured: an uploaded image, an emoji,
// or a letter or two. The value is what the server keeps in `avatar`: the
// image's address, or the short text itself; empty means initials.

import { useRef, useState } from "react";
import { ImageUp, Smile, X } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { isImage, uploadFile } from "@/lib/files";
import { t } from "@/lib/i18n";
import type { Member } from "@/types/core";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

const EMOJI = [
  "🤖",
  "🧠",
  "🎨",
  "🛠️",
  "🧪",
  "📝",
  "🔍",
  "📦",
  "🚀",
  "🧭",
  "🗂️",
  "📊",
  "🧹",
  "🛡️",
  "🎧",
  "🧩",
  "⚙️",
  "🐛",
  "🦉",
  "🦊",
  "🐙",
  "🌱",
  "⭐",
  "🔥",
];

/** The first emoji, or the first two letters or digits, of what was typed. */
function shortAvatar(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let parts: string[];
  try {
    parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)].map((p) => p.segment);
  } catch {
    // oxlint-disable-next-line typescript/no-misused-spread -- a browser without Intl.Segmenter: code points are the best it can do
    parts = [...trimmed];
  }
  const first = parts[0] ?? "";
  if (/^[\p{L}\p{N}]$/u.test(first))
    return parts
      .slice(0, 2)
      .filter((p) => /^[\p{L}\p{N}]$/u.test(p))
      .join("")
      .toUpperCase();
  return first;
}

interface Props {
  /** Who is pictured; `avatar` on it is ignored in favour of `value`. */
  member: Pick<Member, "user_id" | "name" | "kind">;
  value: string;
  /** Takes the new value; may save it at once. A rejection is shown under the buttons. */
  onChange: (next: string) => void | Promise<void>;
  hint?: string;
  disabled?: boolean;
}

export function AvatarInput({ member, value, onChange, hint, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"" | "upload" | "save">("");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");

  async function change(next: string) {
    setError("");
    setBusy((b) => b || "save");
    try {
      await onChange(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    if (!isImage({ content_type: file.type })) {
      setError(t("me.profile.avatarNotImage"));
      return;
    }
    setBusy("upload");
    setPercent(0);
    setError("");
    try {
      const row = await uploadFile(file, {
        onProgress: (p) => setPercent(p.total ? Math.round((p.sent / p.total) * 100) : 0),
      });
      await change(row.url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy("");
    }
  }

  function choose(next: string) {
    setOpen(false);
    setText("");
    if (next) void change(next);
  }

  const off = disabled || busy !== "";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center">
          <Avatar member={{ ...member, avatar: value || undefined }} size="lg" className="scale-[1.75]" />
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={off} onClick={() => input.current?.click()}>
              <ImageUp className="size-3.5" aria-hidden />
              {busy === "upload" ? t("avatar.uploading", { percent }) : t("me.profile.avatarUpload")}
            </Button>
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button disabled={off}>
                  <Smile className="size-3.5" aria-hidden />
                  {t("avatar.emoji")}
                </Button>
              </PopoverTrigger>
              <PopoverContent aria-label={t("avatar.emojiPick")} className="w-64 p-2.5">
                <div className="grid grid-cols-8 gap-0.5">
                  {EMOJI.map((e) => (
                    <button
                      key={e}
                      type="button"
                      aria-label={e}
                      aria-pressed={value === e}
                      onClick={() => choose(e)}
                      className="flex size-7 items-center justify-center rounded-sm text-base leading-none hover:bg-hover aria-pressed:bg-press"
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <div className="mt-2.5 flex items-end gap-1.5 border-t border-line pt-2.5">
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-ink-2">
                    {t("avatar.own")}
                    <Input
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        choose(shortAvatar(text));
                      }}
                      placeholder={t("avatar.ownPlaceholder")}
                      maxLength={16}
                    />
                  </label>
                  <Button
                    variant="primary"
                    className="h-8"
                    disabled={!shortAvatar(text)}
                    onClick={() => choose(shortAvatar(text))}
                  >
                    {t("avatar.use")}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            {value && (
              <Button variant="ghost" disabled={off} onClick={() => void change("")}>
                <X className="size-3.5" aria-hidden />
                {t("me.profile.avatarRemove")}
              </Button>
            )}
          </div>
          {hint && <p className="text-xs text-ink-3">{hint}</p>}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label={t("me.profile.avatarUpload")}
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
