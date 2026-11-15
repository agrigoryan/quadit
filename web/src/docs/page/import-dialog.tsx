import { useState } from "react";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { writeMarkdown } from "@/docs/actions";
import { pickMarkdown, titleOf } from "@/docs/files";
import { createAndOpen } from "@/docs/tree/new-page";
import type { Doc } from "@/lib/types-docs";
import { Button } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Radio, RadioGroup } from "@/ui/radio-group";

type Mode = "replace" | "append" | "subpage";
const MODES: Mode[] = ["replace", "append", "subpage"];

/** Brings a Markdown file into a page: in place of its content, after it, or as a new page under it. */
export function ImportDialog({ doc, open, onClose }: { doc: Doc; open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("replace");

  async function run() {
    const file = await pickMarkdown();
    if (!file) return;
    onClose();
    const { title, body } = titleOf(file.text, file.name);
    if (mode === "subpage") {
      createAndOpen({ parentId: doc.id, title, markdown: body });
      return;
    }
    // Blocks that did not change keep their ids (and comments); a version of the page as it was is kept.
    writeMarkdown(doc.id, mode === "replace" ? body : file.text, mode)
      .then(() => toast.info(t("docs.import.done")))
      .catch(() => {});
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("docs.import.title")}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void run()}>
            {t("docs.import.choose")}
          </Button>
        </>
      }
    >
      <RadioGroup label={t("docs.import.title")} value={mode} onChange={setMode} className="flex flex-col gap-1">
        {MODES.map((m) => (
          <Radio
            key={m}
            value={m}
            className={cx(
              "rounded-md border px-3 py-2 text-left",
              mode === m ? "border-accent bg-accent-soft" : "border-line hover:bg-hover",
            )}
          >
            <span className="block text-sm font-medium">{t(`docs.import.${m}`)}</span>
            <span className="block text-xs text-ink-2">{t(`docs.import.${m}Hint`)}</span>
          </Radio>
        ))}
      </RadioGroup>
    </Dialog>
  );
}
