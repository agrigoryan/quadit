import { t } from "@/lib/i18n";
import { ColorPicker } from "@/settings/ui/bits";
import { type FieldErrors, FormField } from "@/settings/ui/form";
import { Input, Textarea } from "@/ui/input";

export interface ProjectDraft {
  key: string;
  name: string;
  icon: string;
  color: string;
  description: string;
}

export const PROJECT_FIELDS = ["key", "name", "icon", "color", "description"];
export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** A key made from a name: the first letters of its words, or its first three letters. */
function keyFrom(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "").slice(0, 3);
  return key.replace(/^[0-9]+/, "").slice(0, 10);
}

interface Props {
  draft: ProjectDraft;
  set: (patch: Partial<ProjectDraft>) => void;
  errors: FieldErrors;
  /** The key the project has now; changing it gets a warning. */
  currentKey?: string;
  disabled?: boolean;
}

export function ProjectFields({ draft, set, errors, currentKey, disabled }: Props) {
  const keyChanged = !!currentKey && draft.key !== currentKey;
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-[1fr_8rem_5rem]">
        <FormField
          label={t("project.name")}
          htmlFor="project-name"
          error={errors.fields.name}
          className="max-sm:col-span-2"
        >
          <Input
            id="project-name"
            value={draft.name}
            disabled={disabled}
            maxLength={80}
            onChange={(e) => {
              const name = e.target.value;
              // Until the key is typed by hand it follows the name.
              set(!currentKey && draft.key === keyFrom(draft.name) ? { name, key: keyFrom(name) } : { name });
            }}
          />
        </FormField>
        <FormField label={t("project.key")} htmlFor="project-key" error={errors.fields.key}>
          <Input
            id="project-key"
            value={draft.key}
            disabled={disabled}
            maxLength={10}
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono uppercase"
            onChange={(e) => set({ key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
          />
        </FormField>
        <FormField label={t("project.icon")} htmlFor="project-icon" error={errors.fields.icon}>
          <Input
            id="project-icon"
            value={draft.icon}
            disabled={disabled}
            maxLength={4}
            onChange={(e) => set({ icon: e.target.value })}
          />
        </FormField>
      </div>
      {!errors.fields.key && (
        <p className={keyChanged ? "-mt-2 text-xs text-wait" : "-mt-2 text-xs text-ink-3"}>
          {keyChanged ? t("project.keyChange") : t("project.keyHint", { key: draft.key || "KEY" })}
        </p>
      )}
      <FormField label={t("project.color")} error={errors.fields.color}>
        <ColorPicker value={draft.color} onChange={(color) => set({ color })} label={t("project.color")} />
      </FormField>
      <FormField label={t("project.description")} htmlFor="project-desc" error={errors.fields.description}>
        <Textarea
          id="project-desc"
          rows={2}
          value={draft.description}
          disabled={disabled}
          onChange={(e) => set({ description: e.target.value })}
        />
      </FormField>
    </div>
  );
}
