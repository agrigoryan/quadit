import { type FormEvent, useState } from "react";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { createPasskey, passkeyCanceled, passkeysSupported } from "@/auth/webauthn";
import { api, errorMessage } from "@/lib/api";
import { t } from "@/lib/i18n";
import { summariseAgent } from "@/settings/me/user-agent";
import { Fact, LoadGate, When } from "@/settings/ui/bits";
import { ConfirmDialog } from "@/settings/ui/dialogs";
import { FormAlert, FormField, Note } from "@/settings/ui/form";
import { EmptyRow, Row, Rows, Section } from "@/settings/ui/layout";
import { useLoad } from "@/settings/ui/use-load";
import { Button, IconButton } from "@/ui/button";
import { Dialog } from "@/ui/dialog";
import { Input } from "@/ui/input";

interface Passkey {
  id: string;
  name: string;
  created_at: number;
  last_used_at?: number;
}

const PASSKEYS = "/api/v1/auth/passkeys";

/** Names a new passkey (or renames one). For a new one, the browser's own sheet opens on submit. */
function NameDialog({ passkey, onClose, onDone }: { passkey: Passkey | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(passkey?.name ?? summariseAgent(navigator.userAgent));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (passkey) {
        await api.patch(`${PASSKEYS}/${passkey.id}`, { name: name.trim() });
      } else {
        const start = await api.post<{ options: { publicKey: Record<string, unknown> }; state: string }>(`${PASSKEYS}/register/start`);
        const credential = await createPasskey(start.options);
        const query = new URLSearchParams({ state: start.state, name: name.trim() });
        await api.post(`${PASSKEYS}/register/finish?${query.toString()}`, credential);
      }
      onDone();
    } catch (err) {
      // Closing the browser's sheet is a change of mind, not a failure.
      if (!passkeyCanceled(err)) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={passkey ? t("me.passkeys.renameTitle") : t("me.passkeys.addTitle")}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" form="passkey-name" variant="primary" disabled={busy || !name.trim()}>
            {passkey ? t("common.save") : busy ? t("me.passkeys.waiting") : t("me.passkeys.continue")}
          </Button>
        </>
      }
    >
      <form id="passkey-name" onSubmit={submit} className="flex flex-col gap-3.5">
        {!passkey && <p className="text-sm text-ink-2">{t("me.passkeys.addBody")}</p>}
        <FormField label={t("s.name")} htmlFor="passkey-name-input" hint={passkey ? undefined : t("me.passkeys.nameHint")}>
          <Input id="passkey-name-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <FormAlert>{error}</FormAlert>
      </form>
    </Dialog>
  );
}

/** Passkeys: sign in with a fingerprint, a face or a security key instead of a password. */
export function PasskeysSection({ onChanged }: { onChanged: () => void }) {
  const list = useLoad(() => api.get<{ passkeys: Passkey[] }>(PASSKEYS).then((r) => r.passkeys), []);
  const [naming, setNaming] = useState<Passkey | "new" | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const supported = passkeysSupported();

  const changed = () => {
    void list.reload();
    onChanged();
  };

  return (
    <Section
      title={t("me.passkeys.title")}
      lead={t("me.passkeys.lead")}
      actions={
        <Button disabled={!supported} onClick={() => setNaming("new")}>
          <Plus className="size-3.5" aria-hidden />
          {t("me.passkeys.add")}
        </Button>
      }
    >
      <div className="flex flex-col gap-2.5">
        {!supported && <Note tone="wait">{t("me.passkeys.unsupported")}</Note>}
        <LoadGate of={list}>
          {(passkeys) =>
            passkeys.length === 0 ? (
              <EmptyRow>{t("me.passkeys.empty")}</EmptyRow>
            ) : (
              <Rows>
                {passkeys.map((p) => (
                  <Row
                    key={p.id}
                    lead={<KeyRound className="size-4 text-ink-3" aria-hidden />}
                    title={p.name}
                    sub={
                      <>
                        {t("me.passkeys.added")} <When ms={p.created_at} />
                      </>
                    }
                    meta={
                      <Fact label={t("me.lastUsed")} className="max-sm:hidden">
                        <When ms={p.last_used_at} />
                      </Fact>
                    }
                    actions={
                      <>
                        <IconButton label={t("s.rename")} onClick={() => setNaming(p)}>
                          <Pencil className="size-3.5" />
                        </IconButton>
                        <IconButton label={t("s.remove")} onClick={() => setRemoving(p)}>
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      </>
                    }
                  />
                ))}
              </Rows>
            )
          }
        </LoadGate>
      </div>

      {naming && (
        <NameDialog
          passkey={naming === "new" ? null : naming}
          onClose={() => setNaming(null)}
          onDone={() => {
            setNaming(null);
            changed();
          }}
        />
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("me.passkeys.removeTitle", { name: removing?.name ?? "" })}
        body={t("me.passkeys.removeBody")}
        confirm={t("s.remove")}
        onConfirm={async () => {
          await api.del(`${PASSKEYS}/${removing?.id}`);
          changed();
        }}
      />
    </Section>
  );
}
