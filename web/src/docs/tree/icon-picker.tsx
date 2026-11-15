import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { updateDoc } from "@/docs/actions";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/ui/popover";

// A page icon is one emoji. A short, useful set; any emoji can also be typed into the box.
const EMOJI =
  "📄 📝 📌 📎 📚 📖 🗂️ 🗒️ 📋 📊 📈 🗓️ ✅ ☑️ ⭐ 💡 🔥 🚀 🎯 🏁 🧭 🗺️ 🧪 🔬 🛠️ ⚙️ 🧩 🧱 🐛 🔒 🔑 💬 📣 🤝 👥 🧠 🤖 👾 🎮 🕹️ 🎨 🖌️ 🎬 🎵 🎧 📷 🌍 🌱 🌊 ⚡ ❄️ ☀️ 🌙 ❤️ 💎 🏆 🎁 🍀 🍎 ☕ 🏠 🏢 💰 🧾 ✈️ 🚧 ⚠️ ❓ ❗ 🔗 🧵 📦".split(
    " ",
  );

interface Props {
  docId: string;
  current?: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Pick an emoji for a page, type any other one, or take the icon away. */
export function IconPicker({ docId, current, children, open, onOpenChange }: Props) {
  const set = (icon: string) => updateDoc(docId, { icon });
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent aria-label={t("docs.icon.pick")} className="w-64 p-2">
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI.map((emoji) => (
            <PopoverClose asChild key={emoji}>
              <button
                type="button"
                aria-pressed={emoji === current}
                className="flex size-7 items-center justify-center rounded-sm text-base hover:bg-hover aria-pressed:bg-press"
                onClick={() => set(emoji)}
              >
                {emoji}
              </button>
            </PopoverClose>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
          <input
            aria-label={t("docs.icon.type")}
            placeholder={t("docs.icon.type")}
            maxLength={8}
            className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 text-sm outline-none focus:border-accent"
            onKeyDown={(e) => {
              const value = e.currentTarget.value.trim();
              if (e.key === "Enter" && value) {
                set(value);
                onOpenChange?.(false);
                e.currentTarget.blur();
              }
            }}
          />
          {current && (
            <PopoverClose asChild>
              <button
                type="button"
                className="h-7 rounded-md px-2 text-sm text-ink-2 hover:bg-hover hover:text-ink"
                onClick={() => set("")}
              >
                {t("docs.icon.remove")}
              </button>
            </PopoverClose>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
