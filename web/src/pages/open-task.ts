import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import { useSlug } from "@/lib/selectors";

/** Opens a task's panel over the page that is showing, from a key press or a handler. */
export function useOpenTask(): (key: string) => void {
  const slug = useSlug();
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback((key) => navigate(`/${slug}/task/${key}`, { state: { background: location } }), [slug, location, navigate]);
}
