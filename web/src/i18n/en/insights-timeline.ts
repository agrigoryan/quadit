// Strings for the timeline: a project's epics and tasks on a calendar.

export const timelineStrings = {
  "timeline.pageTitle": "{project} timeline",
  "timeline.count": "{n} epic | {n} epics",
  "timeline.zoom": "Zoom",
  "timeline.zoom.weeks": "Weeks",
  "timeline.zoom.months": "Months",
  "timeline.today": "Today",
  "timeline.showCanceled": "Show canceled ({n})",
  "timeline.hideCanceled": "Hide canceled",
  "timeline.expandAll": "Open every epic",
  "timeline.collapseAll": "Close every epic",
  "timeline.keys":
    "Drag a bar or its ends to change dates. With a bar focused: ← → move it a day, Shift changes its end, Alt+Shift its start.",

  "timeline.range": "{from} to {to}",
  "timeline.from": "From {day}, no target date",
  "timeline.until": "Until {day}, no start date",
  "timeline.due": "Due {day}",
  "timeline.bar.epic": "{name}, epic, {state}",
  "timeline.bar.task": "{key} {title}, due date",
  "timeline.milestone": "Milestone: {name}, {day}",

  "timeline.noDates": "No dates",
  "timeline.setDates": "Set dates",
  "timeline.noDue": "No due date",
  "timeline.setDue": "Due in a week",
  "timeline.noTasks": "No tasks in this epic yet",
  "timeline.noEpic": "No epic",
  "timeline.noEpicLong": "Tasks with a due date and no epic",
  "timeline.stateLate": "{state}, {late}",

  "timeline.empty": "Nothing to put on a timeline yet",
  "timeline.emptyHint":
    "Epics with a start and a target date show here as bars, with their tasks underneath. Create an epic first.",
  "timeline.goEpics": "Go to epics",
} as const;
