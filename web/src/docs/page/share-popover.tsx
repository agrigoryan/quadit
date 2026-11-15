// Who can see a page: the whole team, or only its owner and the people the
// owner picks.

import { Check, Link2, Lock, Users } from "lucide-react";
import { useCan } from "@/lib/access";
import { cx } from "@/lib/cx";
import { copyText } from "@/lib/files";
import { t } from "@/lib/i18n";
import { useMe, useMembers, useSlug } from "@/lib/selectors";
import { toast } from "@/lib/toast";
import { setSharing } from "@/docs/actions";
import type { Doc } from "@/lib/types-docs";
import { Avatar } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
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
  const owner = members.find((m) => m.user_id === doc.owner_id);

  const toggle = (userId: string) =>
    setSharing(doc.id, {
      sharedWith: shared.includes(userId) ? shared.filter((id) => id !== userId) : [...shared, userId],
    });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="gap-1 px-2">
          {isPrivate ? <Lock className="size-4" /> : <Users className="size-4" />}
          <span className="max-sm:hidden">{t("docs.share.button")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5">
        <div role="radiogroup" aria-label={t("docs.share.title")}>
          <Choice
            checked={!isPrivate}
            disabled={!mayChange}
            icon={<Users />}
            title={t("docs.share.team")}
            hint={t("docs.share.teamHint")}
            onPick={() => setSharing(doc.id, { private: false })}
          />
          <Choice
            checked={isPrivate}
            disabled={!mayChange}
            icon={<Lock />}
            title={t("docs.share.private")}
            hint={t("docs.share.privateHint")}
            onPick={() => setSharing(doc.id, { private: true })}
          />
        </div>
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
  checked,
  disabled,
  icon,
  title,
  hint,
  onPick,
}: {
  checked: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  title: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled || checked}
      onClick={onPick}
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
    </button>
  );
}
