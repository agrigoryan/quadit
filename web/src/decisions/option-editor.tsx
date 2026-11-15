// One option while a question is being written: its label, description and
// media (added with the button or dropped on the card), whether the asker
// recommends it, and its place in the order.

import { useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, ThumbsUp, Trash2, X } from "lucide-react";
import { cx } from "@/lib/cx";
import { isImage } from "@/lib/files";
import { t } from "@/lib/i18n";
import type { FileRow } from "@/lib/types";
import { Button, IconButton } from "@/ui/button";
import { Input } from "@/ui/input";
import { MediaThumb } from "@/ui/media";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/ui/menu";
import { Spinner } from "@/ui/spinner";
import type { FileRole } from "@/decisions/data";

export interface DraftFile {
  key: string;
  name: string;
  /** Set once the upload has finished. */
  file?: FileRow;
  /** Why the upload failed. */
  failed?: string;
  /** Its part in a before/after pair. */
  role?: FileRole;
}

export interface DraftOption {
  id: string;
  label: string;
  description: string;
  files: DraftFile[];
}

interface Props {
  option: DraftOption;
  index: number;
  total: number;
  /** Shown under the label when it is missing. */
  labelError?: string;
  recommended: boolean;
  reason: string;
  onChange: (fields: Partial<Pick<DraftOption, "label" | "description">>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onRecommend: (on: boolean) => void;
  onReason: (reason: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (key: string) => void;
  onFileRole: (key: string, role: FileRole | undefined) => void;
}

const NO_ROLE = "none";

/** "Before", "After" or neither, for one picture. */
function RolePicker({ entry, onRole }: { entry: DraftFile; onRole: (role: FileRole | undefined) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t("decision.new.roleOf", { name: entry.name })}
          className={cx(
            "mt-1 flex h-5 w-full items-center justify-center rounded-sm text-2xs hover:bg-hover data-[state=open]:bg-hover max-sm:h-7",
            entry.role ? "bg-accent-soft font-medium text-accent-text" : "text-ink-3",
          )}
        >
          {entry.role ? t(`decision.new.role.${entry.role}`) : t("decision.new.role")}
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuRadioGroup value={entry.role ?? NO_ROLE} onValueChange={(value) => onRole(value === NO_ROLE ? undefined : (value as FileRole))}>
          <MenuRadioItem value={NO_ROLE}>{t("decision.new.role.none")}</MenuRadioItem>
          <MenuRadioItem value="before">{t("decision.new.role.before")}</MenuRadioItem>
          <MenuRadioItem value="after">{t("decision.new.role.after")}</MenuRadioItem>
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function Thumb({ entry, onRemove, onRole }: { entry: DraftFile; onRemove: () => void; onRole: (role: FileRole | undefined) => void }) {
  return (
    <li className="relative w-14 shrink-0">
      {entry.file ? (
        <MediaThumb file={entry.file} className="block size-14 rounded-md border border-line" />
      ) : (
        <span
          title={entry.failed ?? entry.name}
          className={cx(
            "flex size-14 items-center justify-center rounded-md border p-1 text-center text-2xs leading-tight",
            entry.failed ? "border-danger bg-danger-soft text-danger" : "border-line bg-sunken",
          )}
        >
          {entry.failed ? t("decision.new.uploadFailed") : <Spinner label={t("decision.new.uploading", { name: entry.name })} />}
        </span>
      )}
      <button
        type="button"
        aria-label={t("decision.new.removeFile", { name: entry.name })}
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-inverse text-inverse-ink shadow-card hover:brightness-125 max-sm:size-7"
      >
        <X className="size-3" strokeWidth={2.5} aria-hidden />
      </button>
      {entry.file && isImage(entry.file) && <RolePicker entry={entry} onRole={onRole} />}
    </li>
  );
}

export function OptionEditor(props: Props) {
  const { option, index, total, labelError, recommended, reason } = props;
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const id = useId();
  const position = index + 1;

  return (
    <li
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) props.onAddFiles([...e.dataTransfer.files]);
      }}
      className={cx("flex gap-2.5 rounded-lg border bg-surface p-3", over ? "border-accent ring-2 ring-accent/25" : "border-line")}
    >
      <span aria-hidden className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm bg-sunken text-2xs font-semibold text-ink-2 tnum">
        {position}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <Input
              value={option.label}
              onChange={(e) => props.onChange({ label: e.target.value })}
              placeholder={t("decision.new.optionLabel", { n: position })}
              aria-label={t("decision.new.optionLabel", { n: position })}
              aria-invalid={!!labelError}
              aria-describedby={labelError ? `${id}-error` : undefined}
              className={cx("font-medium max-sm:h-10 max-sm:text-base", labelError && "border-danger!")}
            />
            {labelError && (
              <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">
                {labelError}
              </p>
            )}
          </div>
          <IconButton label={t("decision.new.moveUp")} disabled={index === 0} onClick={() => props.onMove(-1)} className="mt-0.5 max-sm:size-9">
            <ArrowUp className="size-4" />
          </IconButton>
          <IconButton label={t("decision.new.moveDown")} disabled={index === total - 1} onClick={() => props.onMove(1)} className="mt-0.5 max-sm:size-9">
            <ArrowDown className="size-4" />
          </IconButton>
          <IconButton label={t("decision.new.removeOption")} disabled={total <= 2} onClick={props.onRemove} className="mt-0.5 max-sm:size-9">
            <Trash2 className="size-4" />
          </IconButton>
        </div>
        <Input
          value={option.description}
          onChange={(e) => props.onChange({ description: e.target.value })}
          placeholder={t("decision.new.optionDescription")}
          aria-label={t("decision.new.optionDescription")}
          className="max-sm:h-10 max-sm:text-base"
        />

        <div className="flex flex-wrap items-center gap-2">
          {option.files.length > 0 && (
            <ul className="flex flex-wrap items-start gap-2.5 py-1">
              {option.files.map((entry) => (
                <Thumb
                  key={entry.key}
                  entry={entry}
                  onRemove={() => props.onRemoveFile(entry.key)}
                  onRole={(role) => props.onFileRole(entry.key, role)}
                />
              ))}
            </ul>
          )}
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept="image/*,video/*"
            onChange={(e) => {
              if (e.target.files?.length) props.onAddFiles([...e.target.files]);
              e.target.value = "";
            }}
          />
          <Button variant="ghost" className="max-sm:h-9" onClick={() => picker.current?.click()}>
            <ImagePlus className="size-4" aria-hidden />
            {t("decision.new.addMedia")}
          </Button>
          <span className="flex-1" />
          <Button
            variant="ghost"
            aria-pressed={recommended}
            onClick={() => props.onRecommend(!recommended)}
            className={cx("max-sm:h-9", recommended && "bg-accent-soft! text-accent-text!")}
          >
            <ThumbsUp className="size-4" aria-hidden />
            {recommended ? t("decision.recommended") : t("decision.new.recommend")}
          </Button>
        </div>
        {option.files.some((f) => f.role) && !(option.files.some((f) => f.role === "before") && option.files.some((f) => f.role === "after")) && (
          <p className="text-xs text-ink-3">{t("decision.new.pairHint")}</p>
        )}
        {recommended && (
          <Input
            value={reason}
            autoFocus
            onChange={(e) => props.onReason(e.target.value)}
            placeholder={t("decision.new.reason")}
            aria-label={t("decision.new.reason")}
            className="max-sm:h-10 max-sm:text-base"
          />
        )}
      </div>
    </li>
  );
}
