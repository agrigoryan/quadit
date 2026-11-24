// The outlook: what will happen, for each agent Quadit's runner runs, to a
// comment a member is about to write on a task, or to the member assigning
// it the task, so that the page can say so before it is sent.

package server

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// maxOutlookAgents is how many agents one outlook asks about.
const maxOutlookAgents = 20

// runOutlookRoutes are the routes of the outlook.
func (s *Server) runOutlookRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/tasks/{ref}/run-outlook", s.workspaceMember(s.handleShowRunOutlook), "What will happen, for each agent named, to a comment the caller is about to write on the task (cause=comment, read as an item that mentions it) or to the caller assigning it the task (cause=assign): {outlooks: [{agent, outcome, machine, folder, program, project, owner, since, until, running, reason}]}, in the order asked. outcome: none (Quadit does not run it here, or would not start it for this: what the page said before), will_not_start (reason: no_runner_here, not_responsible, no_responsible), in_chat (a chat holds its listener of the project), when_back (its runner is away, since), paused (reason: why; until, for a usage limit), queued (its runner is busy on the machine, or has items waiting; running: the task of the run open there), starts_now. Every name or key is of the task's own project. An unknown agent is left out.", "agents: the agents' handles or ids, separated by commas, at most 20; cause: comment or assign", "oversight"},
	}
}

// runOutlook is what will happen to the item for one agent: the outcome,
// with its reason, and what the page names in saying so.
type runOutlook struct {
	Agent   string `json:"agent"`
	Outcome string `json:"outcome"`
	Machine string `json:"machine"`
	Folder  string `json:"folder"`
	Program string `json:"program"`
	Project string `json:"project"`
	Owner   string `json:"owner"` // the agent's responsible person's handle
	Since   string `json:"since"` // when_back: when its runner was last heard
	Until   string `json:"until"` // paused for a usage limit: when the runner tries again
	Running string `json:"running"`
	Reason  string `json:"reason"`
}

// The outcomes, in the order they are decided.
const (
	outlookNone         = "none"
	outlookWillNotStart = "will_not_start"
	outlookInChat       = "in_chat"
	outlookWhenBack     = "when_back"
	outlookPaused       = "paused"
	outlookQueued       = "queued"
	outlookStartsNow    = "starts_now"
)

// handleShowRunOutlook answers the outlook of a task for the agents asked.
func (s *Server) handleShowRunOutlook(x *c) error {
	v := x.r.URL.Query()
	typ := map[string]string{"comment": core.NoteMentioned, "assign": core.NoteAssigned}[v.Get("cause")]
	if typ == "" {
		return &engine.Error{Code: engine.CodeInvalid, Field: "cause", Message: "cause is what the caller is about to do: comment or assign", Allowed: []string{"comment", "assign"}}
	}
	var asked []string
	for ref := range strings.SplitSeq(v.Get("agents"), ",") {
		if ref = strings.TrimSpace(ref); ref != "" {
			asked = append(asked, ref)
		}
	}
	if len(asked) == 0 || len(asked) > maxOutlookAgents {
		return &engine.Error{Code: engine.CodeInvalid, Field: "agents", Message: "agents names 1 to 20 agents, by handle or id, separated by commas"}
	}
	t, err := x.taskByRef(x.ctx(), x.r.PathValue("ref"))
	if err != nil {
		return err
	}
	names, err := x.names(x.ctx())
	if err != nil {
		return err
	}
	out := []runOutlook{}
	for _, ref := range asked {
		agent, found := names.agentNamed(ref)
		if !found {
			continue
		}
		o, err := x.runOutlook(x.ctx(), agent, t, typ, names)
		if err != nil {
			return err
		}
		out = append(out, o)
	}
	return x.ok(map[string]any{"outlooks": out})
}

// agentNamed is the current agent of a handle (with or without its @) or
// an id.
func (n *nameLookup) agentNamed(ref string) (core.Member, bool) {
	for _, m := range n.members {
		if m.Kind == core.KindAgent && m.RemovedAt == 0 && m.SuspendedAt == 0 && (m.UserID == ref || "@"+m.Handle == ref || m.Handle == ref) {
			return m, true
		}
	}
	return core.Member{}, false
}

// runOutlook decides the outlook of an item of type typ, by the viewer, on
// task t, for agent; the first rule that applies decides. Only the agent's
// runners of projects the viewer may read count: what it does elsewhere is
// none of the viewer's business.
func (who *viewer) runOutlook(ctx context.Context, agent core.Member, t core.Task, typ string, names *nameLookup) (runOutlook, error) {
	o := runOutlook{Agent: "@" + agent.Handle, Outcome: outlookNone, Project: names.projects[t.ProjectID].Key}
	owner, err := who.ownerOf(ctx, agent.UserID)
	if err != nil {
		return o, err
	}
	o.Owner = names.handle(owner)
	if typ == core.NoteAssigned && t.AssigneeID == agent.UserID {
		return o, nil // assigning it again makes no item
	}
	listeners, err := listenersOf(ctx, who.db, agent.UserID)
	if err != nil {
		return o, err
	}
	if !slices.ContainsFunc(listeners, func(l core.Listener) bool {
		return l.MachineID != "" && l.ProjectID != "" && who.canProject(l.ProjectID)
	}) {
		return o, nil
	}
	l, _ := listeners.of(t.ProjectID)
	if l.MachineID == "" {
		o.Outcome, o.Reason = outlookWillNotStart, "no_runner_here"
		return o, nil
	}
	o.Machine, o.Folder, o.Program = l.MachineName, l.RunnerFolder, l.RunnerProgram
	w, err := who.wakeFor(ctx, agent, who.member, typ, t)
	switch {
	case err != nil:
		return o, err
	case w.Do == wakeRefuse:
		o.Outcome, o.Reason = outlookWillNotStart, w.Why
		return o, nil
	case w.Do == wakeAck:
		return o, nil
	}

	now := time.Now().UnixMilli()
	switch {
	case l.LeaseLives(now) && !l.RunnerHolds:
		o.Outcome = outlookInChat
		return o, nil
	case !l.LeaseLives(now):
		o.Outcome, o.Since = outlookWhenBack, formatTime(l.RunnerSeenAt)
		return o, nil
	case l.RunnerPaused != "":
		o.Outcome, o.Reason = outlookPaused, l.RunnerPaused
		if l.RunnerPaused == core.PauseUsageLimit {
			o.Until = formatTime(l.RunnerPausedUntil)
		}
		return o, nil
	}

	// One run at a time in the folder, whichever agent's: one project is
	// run in one folder of a machine.
	runs, tasks, err := who.openRuns(ctx, []string{t.ProjectID})
	if err != nil {
		return o, err
	}
	if i := slices.IndexFunc(runs, func(run core.AgentSession) bool { return run.MachineID == l.MachineID }); i >= 0 {
		o.Outcome, o.Running = outlookQueued, tasks[runs[i].TaskID].Key
		return o, nil
	}
	waiting, err := who.itemsWaiting(ctx, agent, t.ProjectID)
	if err != nil {
		return o, err
	}
	o.Outcome = outlookStartsNow
	if waiting {
		o.Outcome = outlookQueued
	}
	return o, nil
}

// itemsWaiting reports whether the agent's listener of a project has items
// past its cursor, which its runner takes first.
func (who *viewer) itemsWaiting(ctx context.Context, agent core.Member, projectID string) (bool, error) {
	var cursor core.Cursor
	if _, err := store.Find(ctx, who.db, &cursor, store.Eq("user_id", agent.UserID), store.Eq("name", core.ListenCursorOf(projectID))); err != nil {
		return false, err
	}
	evs, err := who.db.Events(ctx, store.EventFilter{After: cursor.Seq, ProjectIDs: []string{projectID}, OnlyAudience: agent.UserID,
		Types: []string{"notification.created"}, Limit: 1})
	return len(evs) > 0, err
}
