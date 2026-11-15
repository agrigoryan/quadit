// Where the work for this task lives outside Quadit: branches, commits,
// pull requests and plain web addresses, each as a chip that opens it.

import type { Changes } from "@/lib/changes.gen";
import { type FormEvent, useState } from "react";
import { GitBranch, GitCommitHorizontal, GitPullRequest, Link2, Plus, X } from "lucide-react";
import { useCan } from "@/lib/access";
import { t } from "@/lib/i18n";
import { newId } from "@/lib/ids";
import { send } from "@/lib/mutate";
import type { Task, TaskLink } from "@/lib/types";
import { linkName } from "@/detail/data";
import { Section } from "@/detail/section";
import { Button, IconButton } from "@/ui/button";
import { Input } from "@/ui/input";

const icons = { branch: GitBranch, commit: GitCommitHorizontal, pr: GitPullRequest, url: Link2 };

/** Only web addresses are ever made into something to click. */
const isWeb = (url: string) => /^https?:\/\//i.test(url);

function addLink(task: Task, url: string, title: string) {
  const id = newId();
  const args: Changes["link.set"] = { id, task: task.id, kind: "url", url };
  if (title) args.title = title;
  send({ type: "link.set", args }, (tx) =>
    tx.insert("links", { id, task_id: task.id, kind: "url", url, title: title || undefined }),
  );
}

function removeLink(id: string) {
  send({ type: "link.remove", args: { id } }, (tx) => tx.patch("links", id, { deleted_at: Date.now() }));
}

function LinkChip({ link, readOnly }: { link: TaskLink; readOnly: boolean }) {
  const Icon = icons[link.kind] ?? Link2;
  const name = linkName(link);
  const body = (
    <>
      <Icon className="size-3.5 shrink-0 text-ink-2" aria-hidden />
      {link.kind !== "url" && <span className="sr-only">{t(`detail.links.${link.kind}`)}</span>}
      <span className="truncate">{name}</span>
      {link.state && <span className="shrink-0 text-xs text-ink-3">{link.state}</span>}
      {link.checks && <span className="shrink-0 text-xs text-ink-3">{link.checks}</span>}
    </>
  );
  const box = "flex h-7 min-w-0 items-center gap-1.5 pr-1 pl-2 text-sm max-md:h-9";
  return (
    <li className="flex max-w-full min-w-0 items-center rounded-md border border-line">
      {link.url && isWeb(link.url) ? (
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          title={link.url}
          className={`${box} rounded-l-md hover:bg-hover`}
        >
          {body}
        </a>
      ) : (
        <span className={box}>{body}</span>
      )}
      {!readOnly && (
        <IconButton
          label={t("detail.links.remove", { name })}
          size="sm"
          className="mr-0.5 text-ink-3 max-md:size-8"
          onClick={() => removeLink(link.id)}
        >
          <X className="size-3" />
        </IconButton>
      )}
    </li>
  );
}

function AddLink({ task, onDone }: { task: Task; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const address = url.trim();
    if (!address) return;
    addLink(task, isWeb(address) ? address : `https://${address}`, title.trim());
    onDone();
  }

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone();
        }
      }}
      className="mt-2 flex flex-wrap items-center gap-2"
    >
      <Input
        autoFocus
        type="text"
        inputMode="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label={t("detail.links.url")}
        placeholder={t("detail.links.urlPlaceholder")}
        className="h-7 min-w-40 flex-[2] max-md:h-9"
      />
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label={t("detail.links.title")}
        placeholder={t("detail.links.titlePlaceholder")}
        className="h-7 min-w-32 flex-1 max-md:h-9"
      />
      <Button type="submit" variant="primary" className="max-md:h-9" disabled={!url.trim()}>
        {t("common.add")}
      </Button>
      <Button variant="ghost" className="max-md:h-9" onClick={onDone}>
        {t("common.cancel")}
      </Button>
    </form>
  );
}

interface Props {
  task: Task;
  links: TaskLink[];
  /** Start with the add form open (the section was opened to add the first one). */
  startAdding?: boolean;
  /** Called when the add form closes with nothing in the section. */
  onEmptyClose?: () => void;
}

export function Links({ task, links, startAdding, onEmptyClose }: Props) {
  const [adding, setAdding] = useState(!!startAdding);
  const can = useCan();
  const readOnly = !can.editTask(task);

  function closeForm() {
    setAdding(false);
    if (links.length === 0) onEmptyClose?.();
  }

  return (
    <Section
      title={t("detail.links")}
      action={
        !readOnly &&
        !adding && (
          <IconButton label={t("detail.links.add")} size="sm" className="max-md:size-9" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
          </IconButton>
        )
      }
    >
      {links.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {links.map((link) => (
            <LinkChip key={link.id} link={link} readOnly={readOnly} />
          ))}
        </ul>
      )}
      {adding && <AddLink task={task} onDone={closeForm} />}
    </Section>
  );
}
