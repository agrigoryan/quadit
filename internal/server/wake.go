// The wake rule: what Quadit's runner does with one of its agent's inbox
// items, which decides whose words start the agent's program on a person's
// computer. It is said here once, for an item handed out (GET /listen) and
// for one about to be written (the outlook, run_outlook.go). Only the
// words of the agent's responsible person, or of an agent of theirs that
// they control, start a run, and only in a change applied in person: what
// the server writes in someone's name (a rule, a sync, a view's news) never
// does.
// Any read the rule needs that fails is returned, never decided: the hold
// that asked hands nothing out.

package server

import (
	"context"
	"slices"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// wake is what a runner does with one of its agent's inbox items: start a
// run (Do "run"), acknowledge it without one ("ack"), or acknowledge it and
// say on the task that it did not start ("refuse"). Why names the rule.
type wake struct {
	Do  string `json:"do"`
	Why string `json:"why"`
}

// What a runner does with an item (wake.Do).
const (
	wakeRun    = "run"
	wakeAck    = "ack"
	wakeRefuse = "refuse"
)

// The item types that may start a run; any other is acknowledged.
var wakingTypes = []string{core.NoteAssigned, core.NoteMentioned, core.NoteWaitingOn, core.NoteAsked, core.NotePicked, core.NoteUnclear,
	core.NoteReplied, core.NoteComment, core.NoteResult}

// wakeItem is what the rule reads of an item.
type wakeItem struct {
	typ        string
	authorID   string
	addressed  bool
	entityType string
	entityID   string
	taskID     string
	// projectID is the project the item was made in: its task's then.
	projectID string
	// event is the item's notification.created event; nil for an item not
	// written yet, which the caller is about to write themselves.
	event *core.Event
}

// wakeOf decides it for an item handed out: ev is its notification.created
// event (whose data says whether a rule made it), and the item's row is
// read as it is stored now (none: it was taken back). A failed read is
// returned, never decided.
func (who *viewer) wakeOf(ctx context.Context, agent core.Member, ev core.Event) (wake, error) {
	data, err := ev.Payload()
	if err != nil {
		return wake{}, err
	}
	var note core.Notification
	there, err := store.Find(ctx, who.db, &note, store.Eq("id", ev.EntityID))
	switch {
	case err != nil:
		return wake{}, err
	case !there:
		return wake{wakeAck, "gone"}, nil
	case data.Rule != "":
		return wake{wakeAck, "rule"}, nil
	}
	return who.wakeRule(ctx, agent, wakeItem{typ: note.Type, authorID: note.ActorID, addressed: note.Addressed, entityType: note.EntityType,
		entityID: note.EntityID, taskID: note.TaskID, projectID: ev.ProjectID, event: &ev})
}

// wakeFor is the same rule for an item not written yet, of type typ by
// author on task t, addressed to the agent: what the outlook asks.
func (who *viewer) wakeFor(ctx context.Context, agent, author core.Member, typ string, t core.Task) (wake, error) {
	return who.wakeRule(ctx, agent, wakeItem{typ: typ, authorID: author.UserID, addressed: true, entityType: "task", entityID: t.ID, taskID: t.ID,
		projectID: t.ProjectID})
}

// wakeRule is the rule from its third row on, the first that matches
// deciding: what the item is about and what it is, then whose words they
// are.
func (who *viewer) wakeRule(ctx context.Context, agent core.Member, item wakeItem) (wake, error) {
	if item.taskID == "" {
		return wake{wakeAck, "page"}, nil
	}
	var t core.Task
	there, err := store.Find(ctx, who.db, &t, store.Eq("id", item.taskID))
	switch {
	case err != nil:
		return wake{}, err
	// A task that moved to another project since is no longer the item's
	// listener's to start work on, nor one the viewer's credential may reach.
	case !there || t.DeletedAt != 0 || !agent.Scope.MayRead(t.ProjectID) || t.ProjectID != item.projectID || !who.canProject(t.ProjectID):
		return wake{wakeAck, "gone"}, nil
	case item.authorID == agent.UserID:
		return wake{wakeAck, "own"}, nil
	case item.typ == core.NoteStatus:
		return wake{wakeAck, "status"}, nil
	case item.typ == core.NoteWaitingOn && item.entityType == "resource":
		return wake{wakeAck, "resource"}, nil
	case item.typ == core.NoteAsked || item.typ == core.NoteUnclear:
		var d core.Decision
		open, err := store.Find(ctx, who.db, &d, store.Eq("id", item.entityID), store.Live, store.Eq("state", core.StateOpen), store.Eq("asked_id", agent.UserID))
		if err != nil {
			return wake{}, err
		}
		if !open {
			return wake{wakeAck, "answered"}, nil
		}
	case (item.typ == core.NoteComment || item.typ == core.NoteResult) && !item.addressed:
		return wake{wakeAck, "follow"}, nil
	case !slices.Contains(wakingTypes, item.typ):
		return wake{wakeAck, "unknown"}, nil
	}

	// Whose words they are. The responsible persons of the agent, of the
	// author and of the author's maker are read in one go, so they are of
	// one moment.
	author, authorCurrent, err := who.currentMember(ctx, item.authorID)
	if err != nil {
		return wake{}, err
	}
	ids := []string{agent.UserID, item.authorID}
	if author.DelegatedBy != "" {
		ids = append(ids, author.DelegatedBy)
	}
	var users []core.User
	if err := who.st.List(ctx, &users, store.Where(store.In("id", ids))); err != nil {
		return wake{}, err
	}
	ownerOf := map[string]string{}
	for _, u := range users {
		ownerOf[u.ID] = u.ResponsibleID
	}
	owner := ownerOf[agent.UserID]
	if owner != "" {
		_, current, err := who.currentMember(ctx, owner)
		if err != nil {
			return wake{}, err
		}
		if !current {
			owner = ""
		}
	}
	if owner == "" {
		return wake{wakeRefuse, core.RunNoResponsible}, nil
	}
	if item.authorID != owner {
		// An agent of the owner's: answering to the owner, and not a helper
		// another member made and holds a token of, whoever it names.
		if !authorCurrent || author.Kind != core.KindAgent || ownerOf[author.UserID] != owner {
			return wake{wakeRefuse, core.RunNotResponsible}, nil
		}
		if maker := author.DelegatedBy; maker != "" && maker != owner {
			m, current, err := who.currentMember(ctx, maker)
			if err != nil {
				return wake{}, err
			}
			if !current || m.Kind != core.KindAgent || ownerOf[maker] != owner {
				return wake{wakeRefuse, core.RunNotResponsible}, nil
			}
		}
	}
	if item.event != nil {
		inPerson, err := who.appliedInPerson(ctx, *item.event)
		if err != nil {
			return wake{}, err
		}
		if !inPerson {
			return wake{wakeAck, "background"}, nil
		}
	}
	return wake{wakeRun, "for_you"}, nil
}

// appliedInPerson reports whether an event came from a change its actor
// applied themselves, which the engine records as applied by them, and not
// from a write the server made in their name: a rule, a sync with GitHub or
// a repository, a saved view's news, a job. Only those it never records.
func (who *viewer) appliedInPerson(ctx context.Context, ev core.Event) (bool, error) {
	if !id.Valid(ev.ChangeID) {
		return false, nil
	}
	var applied core.AppliedChange
	return store.Find(ctx, who.db, &applied, store.Eq("id", ev.ChangeID), store.Eq("actor_id", ev.ActorID))
}

// ownerOf is the person responsible for an agent, as its account says
// (Member.ResponsibleID is filled only for lists), while they are a
// current member of this workspace; "" when there is none.
func (who *viewer) ownerOf(ctx context.Context, agentID string) (string, error) {
	var u core.User
	if err := who.st.Get(ctx, &u, store.Eq("id", agentID)); err != nil || u.ResponsibleID == "" {
		return "", err
	}
	_, current, err := who.currentMember(ctx, u.ResponsibleID)
	if err != nil || !current {
		return "", err
	}
	return u.ResponsibleID, nil
}

// currentMember is a member of this workspace, and whether they are one
// now: not removed, not suspended.
func (who *viewer) currentMember(ctx context.Context, userID string) (core.Member, bool, error) {
	var m core.Member
	there, err := store.Find(ctx, who.db, &m, store.Eq("user_id", userID), store.Null("removed_at"), store.Null("suspended_at"))
	return m, there, err
}
