package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// Background jobs wait in the database until their time. Any server may
// claim one; a job that fails is tried again, five times at most.

// jobKinds maps a job kind to what runs it.
var jobKinds = map[string]func(s *Server, ctx context.Context, j core.Job) error{
	"notify": (*Server).jobNotify,
}

// enqueue adds a job. With a dedupe name, a second job of the same name is
// not added while the first still waits.
func (s *Server) enqueue(ctx context.Context, kind, workspaceID, dedupe string, payload any, runAt time.Time) {
	raw, _ := json.Marshal(payload)
	j := core.Job{ID: id.New(), Kind: kind, WorkspaceID: workspaceID, Dedupe: dedupe, Payload: raw, RunAt: runAt.UnixMilli(), CreatedAt: time.Now().UnixMilli()}
	if err := s.st.Insert(ctx, j); err != nil && !errors.Is(err, store.ErrConflict) {
		s.log.Error("enqueue", "kind", kind, "err", err)
	}
}

func (s *Server) runJobs(ctx context.Context) {
	worker := id.New()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		now := time.Now().UnixMilli()
		var due []core.Job
		if err := s.st.List(ctx, &due, store.Q{Where: []store.Cond{store.Null("done_at"), store.Lte("run_at", now)}, Order: "run_at", Limit: 20}); err != nil {
			continue
		}
		for _, j := range due {
			if j.ClaimedUntil > now {
				continue // another worker has it
			}
			// Claim it for five minutes; if this server dies, another takes over.
			n, err := s.st.Update(ctx, "jobs", map[string]any{"claimed_by": worker, "claimed_until": now + 300_000, "attempts": j.Attempts + 1},
				store.Eq("id", j.ID), store.Eq("attempts", j.Attempts), store.Null("done_at"))
			if err != nil || n != 1 {
				continue
			}
			run, ok := jobKinds[j.Kind]
			var jerr error
			if !ok {
				jerr = fmt.Errorf("unknown job kind %q", j.Kind)
			} else {
				jerr = run(s, ctx, j)
			}
			set := map[string]any{"claimed_until": 0}
			switch {
			case jerr == nil:
				set["done_at"], set["error"] = time.Now().UnixMilli(), ""
			case j.Attempts+1 >= 5 || !ok:
				set["done_at"], set["error"] = time.Now().UnixMilli(), oneLine(jerr.Error(), 500)
				s.log.Error("job gave up", "kind", j.Kind, "err", jerr)
			default:
				set["run_at"], set["error"] = time.Now().Add(backoff(j.Attempts+1)).UnixMilli(), oneLine(jerr.Error(), 500)
			}
			s.st.Update(ctx, "jobs", set, store.Eq("id", j.ID))
		}
		// Finished jobs are kept a week for the health panel, then dropped.
		s.st.Delete(ctx, "jobs", store.NotNull("done_at"), store.Lt("done_at", now-7*24*3600_000))
	}
}

// notifyPrefs are a person's choices about being told outside the app.
type notifyPrefs struct {
	Push  *bool  `json:"push"`  // default on, for browsers that subscribed
	Email string `json:"email"` // all, important (default), none
}

var importantNotes = map[string]bool{core.NoteAsked: true, core.NoteMentioned: true, core.NoteAssigned: true, core.NotePicked: true,
	core.NoteUnclear: true, core.NoteWaitingOn: true, core.NoteResult: true, core.NoteBudget: true}

var noteVerbs = map[string]string{core.NoteAssigned: "assigned you", core.NoteMentioned: "mentioned you in", core.NoteWaitingOn: "is waiting on you in",
	core.NoteAsked: "asked you a question in", core.NotePicked: "answered your question in", core.NoteUnclear: "found your answer unclear in",
	core.NoteReplied: "replied to you in", core.NoteComment: "commented on", core.NoteResult: "posted a result in", core.NoteStatus: "changed the status of",
	core.NoteBudget: "budget warning:"}

// jobNotify tells a person about an inbox item by push and mail, unless
// they have already read it.
func (s *Server) jobNotify(ctx context.Context, j core.Job) error {
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(j.Payload, &p)
	db := s.st.In(j.WorkspaceID)
	var n core.Notification
	if err := db.Get(ctx, &n, store.Eq("id", p.ID)); err != nil || n.ReadAt != 0 {
		return nil
	}
	var u core.User
	if err := s.st.Get(ctx, &u, store.Eq("id", n.UserID), store.Live); err != nil || u.Kind != core.KindPerson || u.DisabledAt != 0 {
		return nil // agents are woken through the feed and webhooks
	}
	var prefs notifyPrefs
	if len(u.Notify) > 0 {
		json.Unmarshal(u.Notify, &prefs)
	}
	var ws core.Workspace
	var actor core.Member
	s.st.Get(ctx, &ws, store.Eq("id", j.WorkspaceID))
	db.Get(ctx, &actor, store.Eq("user_id", n.ActorID))
	link := s.cfg.BaseURL + "/" + ws.Slug + "/inbox"
	if n.TaskID != "" {
		link = s.cfg.BaseURL + "/" + ws.Slug + "/task/" + strings.SplitN(n.Title, " ", 2)[0]
	} else if n.DocID != "" {
		link = s.cfg.BaseURL + "/" + ws.Slug + "/docs/" + n.DocID
	}
	title := strings.TrimSpace(actor.Name + " " + noteVerbs[n.Type] + " " + n.Title)
	if prefs.Push == nil || *prefs.Push {
		if _, err := s.pushTo(ctx, u.ID, pushMessage{Title: title, Body: n.Snippet, URL: strings.TrimPrefix(link, s.cfg.BaseURL), Tag: n.TaskID + n.DocID}); err != nil {
			s.log.Warn("push", "err", err)
		}
	}
	wantMail := prefs.Email == "all" || ((prefs.Email == "" || prefs.Email == "important") && importantNotes[n.Type])
	if wantMail && u.Email != "" && s.mailReady(ctx) {
		body := title
		if n.Snippet != "" {
			body += "\n\n" + n.Snippet
		}
		body += "\n\n" + link
		return s.sendMail(ctx, u.Email, title, body)
	}
	return nil
}
