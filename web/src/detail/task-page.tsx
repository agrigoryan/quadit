// A task on its own page, at /:ws/task/KEY: what a link from outside the
// app opens, and what Enter opens from a list. The whole width is the
// task's: description and timeline in the middle, properties at the side.

import { useParams } from "react-router";
import { TaskView } from "@/detail/task-view";

interface Props {
  /** Back to where the person came from, or to the task's list when they came from nowhere. */
  onBack: () => void;
}

export function TaskPage({ onBack }: Props) {
  const taskKey = (useParams().key ?? "").toUpperCase();
  return (
    <div data-task-page className="flex h-full flex-col">
      <TaskView key={taskKey} taskKey={taskKey} layout="page" onClose={onBack} />
    </div>
  );
}
