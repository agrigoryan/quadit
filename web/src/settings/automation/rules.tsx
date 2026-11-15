import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { errorMessage } from "@/lib/api";
import { cx } from "@/lib/cx";
import { t } from "@/lib/i18n";
import { useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { Button, IconButton } from "@/ui/button";
import { useSettingsBase } from "@/settings/base";
import { LoadGate } from "@/settings/ui/bits";
import { ConfirmDialog } from "@/settings/ui/dialogs";
import { Switch } from "@/settings/ui/form";
import { EmptyRow, Page, Rows } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";
import { change, listRows, type Rule, type Webhook } from "@/settings/automation/data";
import { RuleForm } from "@/settings/automation/rule-form";
import { RuleSentence } from "@/settings/automation/rule-text";

/** Rules: "when this happens, do that", run by the server on every event. */
export function RulesPage() {
  const slug = useSlug();
  const base = useSettingsBase();
  const data = useLoad(async () => {
    const [rules, hooks] = await Promise.all([listRows<Rule>(slug, "rules"), listRows<Webhook>(slug, "webhooks")]);
    return { rules, hooks };
  }, [slug]);
  const [form, setForm] = useState<{ rule?: Rule } | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);

  async function toggle(rule: Rule, active: boolean) {
    data.set((d) => d && { ...d, rules: d.rules.map((r) => (r.id === rule.id ? { ...r, active } : r)) });
    try {
      await change("rule.update", { id: rule.id, active });
    } catch (err) {
      toast.error(errorMessage(err));
    }
    await data.reload();
  }

  return (
    <Page
      title={t("settings.nav.rules")}
      lead={t("auto.rule.lead")}
      back={base}
      actions={
        <Button variant="primary" onClick={() => setForm({})}>
          <Plus className="size-4" aria-hidden />
          {t("auto.rule.new")}
        </Button>
      }
    >
      <LoadGate of={data}>
        {({ rules, hooks }) =>
          rules.length === 0 ? (
            <EmptyRow>{t("auto.rule.empty")}</EmptyRow>
          ) : (
            <Rows>
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-start gap-3 px-3 py-2.5">
                  <span className="pt-0.5">
                    <Switch
                      checked={rule.active}
                      onChange={(on) => void toggle(rule, on)}
                      label={t("auto.rule.activeFor", { name: rule.name })}
                    />
                  </span>
                  <button type="button" onClick={() => setForm({ rule })} className="min-w-0 flex-1 text-left">
                    <span className={cx("block truncate text-sm font-medium", rule.active ? "text-ink" : "text-ink-3")}>
                      {rule.name}
                    </span>
                    <span className={cx("block", !rule.active && "opacity-60")}>
                      <RuleSentence rule={rule} hooks={hooks} />
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <IconButton label={t("common.edit")} onClick={() => setForm({ rule })}>
                      <Pencil className="size-3.5" />
                    </IconButton>
                    <IconButton label={t("s.delete")} onClick={() => setRemoving(rule)}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </span>
                </div>
              ))}
            </Rows>
          )
        }
      </LoadGate>

      {form && (
        <RuleForm
          rule={form.rule}
          hooks={data.data?.hooks ?? []}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void data.reload();
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("auto.rule.deleteTitle", { name: removing?.name ?? "" })}
        body={t("auto.rule.deleteBody")}
        confirm={t("s.delete")}
        onConfirm={async () => {
          if (removing) await change("rule.delete", { id: removing.id });
          await data.reload();
        }}
      />
    </Page>
  );
}
