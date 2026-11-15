// Adding a file to an option of a question that is already asked. The file
// can be marked as the "before" or the "after" of a change; an option with
// one of each shows them as a pair.

import { useRef } from "react";
import { ArrowLeftToLine, ArrowRightToLine, Paperclip } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Decision, DecisionOption } from "@/types/core";
import { uploadOrToast } from "@/detail/uploads";
import { IconButton } from "@/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu";
import { attachToOption } from "@/decisions/actions";
import type { FileRole } from "@/decisions/data";

export function AttachToOption({ decision, option }: { decision: Decision; option: DecisionOption }) {
  const chooser = useRef<HTMLInputElement | null>(null);
  /** What the files being chosen will be marked as. */
  const role = useRef<FileRole | undefined>(undefined);

  function choose(as: FileRole | undefined) {
    role.current = as;
    if (chooser.current) chooser.current.multiple = !as;
    chooser.current?.click();
  }

  async function add(files: File[]) {
    const as = role.current;
    for (const file of files) {
      const row = await uploadOrToast(file);
      if (row) attachToOption(decision, option.id, row, as);
    }
  }

  return (
    <>
      <input
        ref={chooser}
        type="file"
        hidden
        onChange={(e) => {
          void add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={t("decision.attach", { label: option.label })} size="sm" className="max-sm:size-9">
            <Paperclip className="size-3.5" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Paperclip />} onSelect={() => choose(undefined)}>
            {t("decision.attach.plain")}
          </MenuItem>
          <MenuItem icon={<ArrowLeftToLine />} onSelect={() => choose("before")}>
            {t("decision.attach.before")}
          </MenuItem>
          <MenuItem icon={<ArrowRightToLine />} onSelect={() => choose("after")}>
            {t("decision.attach.after")}
          </MenuItem>
        </MenuContent>
      </Menu>
    </>
  );
}
