// Words the insight pages share: navigation, progress and agent states.

export const coreStrings = {
  "nav.agents": "Agents",
  "nav.decisions": "Decisions",
  "nav.timeline": "Timeline",

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
  "ins.agent.notListeningHint":
    "Nothing would wake this agent: no chat or companion listens for it and no webhook pushes to it. Say “listen to Quadit” in its tool.",
} as const;
