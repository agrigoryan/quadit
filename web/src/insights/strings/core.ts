// Words the insight pages share: navigation, time, progress and agent states.

export const coreStrings = {
  "nav.agents": "Agents",
  "nav.decisions": "Decisions",
  "nav.timeline": "Timeline",

  "ins.time.m": "{m}m",
  "ins.time.hm": "{h}h {m}m",
  "ins.time.dh": "{d}d {h}h",
  "ins.loadFailed": "Could not load this: {why}",
  "ins.allProjects": "All projects",
  "ins.project": "Project",

  "ins.progress": "{done} of {total} done",
  "ins.progress.withStarted": "{done} of {total} done, {started} under way",
  "ins.points": "{done} of {total} points",

  "ins.agent.state.working": "Working",
  "ins.agent.state.waiting": "Waiting",
  "ins.agent.state.has_work": "Has work",
  "ins.agent.state.idle": "Idle",
  "ins.agent.notListening": "Not listening",
  "ins.agent.notListeningUrgent": "Work is waiting, nothing is listening",
  "ins.agent.notListeningHint": "Nothing would wake this agent: no companion is holding a wait for it and no webhook pushes to it.",
  "ins.agent.budget": "{cost} of {budget} this week",
  "ins.agent.budget.near": "Close to the limit",
  "ins.agent.budget.over": "Used up",
  "ins.agent.spentNoBudget": "{cost} and {time} this week, no budget set",
  "ins.agent.nothingSpent": "Nothing spent this week",
} as const;
