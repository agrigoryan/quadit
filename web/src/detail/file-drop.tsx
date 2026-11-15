// Dropping files anywhere on a task attaches them. The part of the screen
// that shows the task spreads `handlers` on its frame and draws `note`
// inside it.

import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import type { Task } from "@/lib/types";
import { attachToTask, carriesFiles } from "@/detail/uploads";

interface FileDrop {
  handlers: {
    onDragEnter: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDropCapture: () => void;
    onDrop: (e: DragEvent) => void;
  };
  /** The dashed frame that says files can be dropped, while some are held over the task. */
  note: ReactNode;
}

export function useFileDrop(task: Task | undefined): FileDrop {
  const [dragging, setDragging] = useState(false);
  const canDrop = !!task && !task.deleted_at;
  // dragenter and dragleave fire for every child crossed; count them to know when the drag has really left.
  const depth = useRef(0);

  function drag(e: DragEvent, step: 1 | -1) {
    if (!canDrop || !carriesFiles(e)) return;
    depth.current = Math.max(0, depth.current + step);
    setDragging(depth.current > 0);
  }
  function endDrag() {
    depth.current = 0;
    setDragging(false);
  }

  return {
    handlers: {
      onDragEnter: (e) => drag(e, 1),
      onDragLeave: (e) => drag(e, -1),
      onDragOver: (e) => {
        if (canDrop && carriesFiles(e)) e.preventDefault();
      },
      onDropCapture: endDrag,
      onDrop: (e) => {
        if (!task || !canDrop || !carriesFiles(e)) return;
        e.preventDefault();
        attachToTask(task, [...e.dataTransfer.files]);
      },
    },
    note: dragging && (
      <div className="pointer-events-none absolute inset-1 z-10 flex items-start justify-center rounded-lg border-2 border-dashed border-accent pt-14">
        <span className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-accent-ink shadow-pop">
          {t("detail.files.drop")}
        </span>
      </div>
    ),
  };
}
