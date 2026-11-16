import { useNavigate } from "react-router";
import { useHotkeys } from "@/hooks/hotkeys";
import { canGoBack } from "@/nav/task-link";

/**
 * Escape leaves a page of its own (an epic, a cycle, a page of the docs) as
 * the task's page is left: back to where the person was, or to `parent`, the
 * list the page belongs to, when they arrived by its address. Not while a
 * field is typed in, nor while something open over the page or the task
 * panel has Escape; `enabled` false leaves it to something else the page has
 * open.
 */
export function useEscapeBack(parent: string, enabled = true) {
  const navigate = useNavigate();
  useHotkeys(
    {
      Escape: () => void (canGoBack() ? navigate(-1) : navigate(parent)),
    },
    { enabled },
  );
}
