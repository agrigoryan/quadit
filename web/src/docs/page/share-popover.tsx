// Who can see a page: the whole team, or only its owner and the people the
// owner picks.

import { Check, Link2, Lock, Users } from "lucide-react";
import { useCan } from "@/data/access";
import { cx } from "@/lib/cx";
import { copyText } from "@/data/files";
import { t } from "@/lib/i18n";
import { useMe, useMember, useMembers, useSlug } from "@/data/selectors";
import { toast } from "@/lib/toast";
import { setSharing } from "@/docs/actions";
import type { Doc } from "@/types/docs";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Radio, RadioGroup } from "@/ui/radio-group";
import { docPath } from "@/docs/area";

export function SharePopover({ doc }: { doc: Doc }) {
  const me = useMe();
  const slug = useSlug();
  const members = useMembers();
  const isPrivate = !!doc.owner_id;
  const mine = !doc.owner_id || doc.owner_id === me.user_id;
  const can = useCan();
  const mayChange = mine && can.edit(doc.project_id);
  const shared = doc.shared_with ?? [];
  // The owner may have left the workspace since: they are still named.
  const owner = useMember(doc.owner_id ?? undefined);

  const toggle = (userId: string) =>
    setSharing(doc.id, {
      sharedWith: shared.includes(userId) ? shared.filter((id) => id !== userId) : [...shared, userId],
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="gap-1 px-2">
          {isPrivate ? <Lock className="size-4" /> : <Users className="size-4" />}
          <span className="max-sm:sr-only">{t("docs.share.button")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label={t("docs.share.title")} className="w-80 p-1.5">
        <RadioGroup
          label={t("docs.share.title")}
          value={isPrivate ? "private" : "team"}
          onChange={(to) => setSharing(doc.id, { private: to === "private" })}
          disabled={!mayChange}
        >
          <Choice
            value="team"
            checked={!isPrivate}
            disabled={!mayChange}
            icon={<Users />}
            title={t("docs.share.team")}
            hint={t("docs.share.teamHint")}
          />
          <Choice
            value="private"
            checked={isPrivate}
            disabled={!mayChange}
            icon={<Lock />}
            title={t("docs.share.private")}
            hint={t("docs.share.privateHint")}
          />
        </RadioGroup>
        {isPrivate && (
          <div className="mt-1 border-t border-line pt-1.5">
            <p className="px-2 pb-1 text-xs font-medium text-ink-3">
              {mine ? t("docs.share.with") : t("docs.share.ownedBy", { name: owner?.name ?? t("common.someone") })}
            </p>
            <ul className="max-h-56 overflow-y-auto">
              {members
                .filter((m) => m.user_id !== doc.owner_id && (mine || shared.includes(m.user_id)))
                .map((m) => (
                  <li key={m.user_id}>
                    <button
                      type="button"
                      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a button drawn as a box; a native checkbox would need a hidden input and a label
                      role="checkbox"
                      aria-checked={shared.includes(m.user_id)}
                      disabled={!mayChange}
                      onClick={() => toggle(m.user_id)}
                      className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-hover disabled:hover:bg-transparent"
                    >
                      <Avatar member={m} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{m.name}</span>
                      <span className="text-xs text-ink-3">@{m.handle}</span>
                      <Check className={cx("size-4 text-accent-text", !shared.includes(m.user_id) && "invisible")} />
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}
        <div className="mt-1 border-t border-line pt-1.5">
          <button
            type="button"
            onClick={() =>
              void copyText(location.origin + docPath(slug, doc.id)).then((ok) =>
                toast.info(t(ok ? "common.copied" : "common.copyFailed")),
              )
            }
            className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-sm hover:bg-hover"
          >
            <Link2 className="size-4 text-ink-2" />
            {t("docs.copyLink")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Choice({
  value,
  checked,
  disabled,
  icon,
  title,
  hint,
}: {
  value: string;
  checked: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <Radio
      value={value}
      className={cx(
        "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover disabled:hover:bg-transparent [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        checked ? "[&>svg]:text-accent-text" : "[&>svg]:text-ink-3",
        disabled && !checked && "opacity-50",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-ink-2">{hint}</span>
      </span>
      <Check className={cx("!text-accent-text", !checked && "invisible")} />
    </Radio>
  );
}
