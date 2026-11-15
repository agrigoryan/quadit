// The row of properties under a new task's description in the create
// dialog: each property's own pill (tasks/properties), then the template the
// task starts from.

import { CircleSlash, FileStack } from "lucide-react";
import { t } from "@/lib/i18n";
import { useTemplates } from "@/data/selectors";
import { CREATE } from "@/tasks/properties";
import { orNone, Pill, pill } from "@/tasks/properties/create-pill";
import { type CreateProps, NONE } from "@/tasks/properties/property";
import { Picker } from "@/ui/picker";

/** The row of properties under the description: each a small button that opens a picker. */
export function CreateFields(props: CreateProps) {
  const { project, value, onChange, shared } = props;
  const templates = useTemplates(project.id);
  const template = templates.find((tp) => tp.id === value.templateId);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CREATE.map(({ name, Create }) => (
        <Create key={name} {...props} />
      ))}

      {!shared && templates.length > 0 && (
        <Picker
          label={t("prop.template")}
          placeholder={t("prop.template")}
          value={value.templateId || NONE}
          items={[
            { id: NONE, label: t("common.none"), icon: <CircleSlash className="size-3.5 text-ink-3" aria-hidden /> },
            ...templates.map((tp) => ({ id: tp.id, label: tp.name })),
          ]}
          onPick={(id) => onChange({ templateId: orNone(id) })}
        >
          <button type="button" className={pill}>
            <Pill icon={<FileStack className="size-3.5" aria-hidden />} set={!!template}>
              {template?.name ?? t("prop.template")}
            </Pill>
          </button>
        </Picker>
      )}
    </div>
  );
}
