// A task on its own page, at /:ws/task/KEY: what a link from outside the
// app opens, and what Enter opens from a list. The whole width is the
// task's: description and timeline in the middle, properties at the side.
// Opened from a list, it knows its place in it: J and K go to the next and
// previous task of that list, in the same step of the browser's history.

import { useLocation, useNavigate, useParams } from "react-router";
import { useSlug } from "@/data/selectors";
import { type QueuePlace, TaskView } from "@/detail/task-view";
import { taskPath } from "@/nav/task-link";
import { cameFrom, markSeen, placeInQueue } from "@/nav/task-queue";

interface Props {
  /** Back to where the person came from, or to the task's list when they came from nowhere. */
  onBack: () => void;
}

/** The task's place in the list its page was opened from, and how to step along it. */
function useQueue(taskKey: string): QueuePlace | undefined {
  const slug = useSlug();
  const location = useLocation();
  const navigate = useNavigate();
  const from = cameFrom(location.state);
  const place = placeInQueue(from, taskKey);
  if (!from || !place) return undefined;
  return {
    at: place.at,
    total: place.keys.length,
    step(by) {
      const next = place.keys[place.at + by];
      if (!next) return;
      markSeen(from, next);
      void navigate(taskPath(slug, next), { replace: true, state: { from } });
    },
  };
}

export function TaskPage({ onBack }: Props) {
  const taskKey = (useParams().key ?? "").toUpperCase();
  const queue = useQueue(taskKey);
  return (
    <div data-task-page className="flex h-full flex-col">
      <TaskView key={taskKey} taskKey={taskKey} layout="page" onClose={onBack} queue={queue} />
    </div>
  );
}
