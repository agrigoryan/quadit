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
	"github.com/agrigoryan/quadit/internal/plainjson"
	"github.com/agrigoryan/quadit/internal/store"
)

// Background jobs wait in the database until their time. Any server may
// claim one; a job that fails is tried again, five times at most.

// Timing of jobs.
const (
	jobTick      = 2 * time.Second
	jobClaim     = 5 * time.Minute    // how long a claimed job is held; if its server dies, another takes over
	jobKeep      = 7 * 24 * time.Hour // finished jobs are kept this long for the health panel
	jobBatch     = 20                 // how many due jobs are read at a time
	jobMaxTries  = 5
	jobErrorSize = 500 // how much of a job's error is kept
)

// lastErrorSize is how much of the error a backup, a sync or an
// integration's pass ended in is kept on its record.
const lastErrorSize = 400

// Recording what became of background work.
const (
	outcomeTries = 3                      // how many times the write is tried
	outcomePause = 200 * time.Millisecond // the wait before the second try; it doubles after
)

// jobKinds maps a job kind to what runs it.
var jobKinds = map[string]func(s *Server, ctx context.Context, j core.Job) error{
	"notify": (*Server).jobNotify,
}

// enqueue adds a job. With a dedupe name, a second job of the same name is
// not added while the first still waits, and that is not an error.
func (s *Server) enqueue(ctx context.Context, kind, workspaceID, dedupe string, payload any, runAt time.Time) error {
	raw := plainjson.Marshal(payload)
	j := core.Job{ID: id.New(), Kind: kind, WorkspaceID: workspaceID, Dedupe: dedupe, Payload: raw, RunAt: runAt.UnixMilli(), CreatedAt: time.Now().UnixMilli()}
	if err := s.st.Insert(ctx, j); err != nil && !errors.Is(err, store.ErrConflict) {
		return fmt.Errorf("queueing a %s job: %w", kind, err)
	}
	return nil
}

// runJobs runs the jobs that are due until ctx ends.
func (s *Server) runJobs(ctx context.Context) {
	worker := id.New()
	tick := time.NewTicker(jobTick)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		now := time.Now().UnixMilli()
		var due []core.Job
		if err := s.st.List(ctx, &due, store.Q{Where: []store.Cond{store.Null("done_at"), store.Lte("run_at", now)}, Order: "run_at", Limit: jobBatch}); err != nil {
			continue
		}
		for _, j := range due {
			s.runJob(ctx, worker, now, j)
		}
		if _, err := s.st.Delete(ctx, "jobs", store.NotNull("done_at"), store.Lt("done_at", now-jobKeep.Milliseconds())); err != nil {
			s.log.Warn("dropping old jobs", "err", err) // they are dropped on a later pass
		}
	}
}

// runJob claims one due job, runs it and records how it went: done, given
// up, or to be tried again later.
func (s *Server) runJob(ctx context.Context, worker string, now int64, j core.Job) {
	if j.ClaimedUntil > now {
		return // another worker has it
	}
	n, err := s.st.Update(ctx, "jobs", map[string]any{"claimed_by": worker, "claimed_until": now + jobClaim.Milliseconds(), "attempts": j.Attempts + 1},
		store.Eq("id", j.ID), store.Eq("attempts", j.Attempts), store.Null("done_at"))
	if err != nil || n != 1 {
		return
	}
	run, ok := jobKinds[j.Kind]
	var runErr error
	if !ok {
		runErr = fmt.Errorf("unknown job kind %q", j.Kind)
	} else {
		runErr = run(s, ctx, j)
	}
	set := map[string]any{"claimed_until": 0}
	switch {
	case runErr == nil:
		set["done_at"], set["error"] = time.Now().UnixMilli(), ""
	case j.Attempts+1 >= jobMaxTries || !ok:
		set["done_at"], set["error"] = time.Now().UnixMilli(), oneLine(runErr.Error(), jobErrorSize)
		s.log.Error("job gave up", "kind", j.Kind, "err", runErr)
	default:
		set["run_at"], set["error"] = time.Now().Add(backoff(j.Attempts+1)).UnixMilli(), oneLine(runErr.Error(), jobErrorSize)
	}
	// A job that ran is recorded even when the server is stopping; one not
	// recorded runs again when its claim runs out.
	s.recordOutcome(context.WithoutCancel(ctx), "job", func(ctx context.Context) error {
		_, err := s.st.Update(ctx, "jobs", set, store.Eq("id", j.ID))
		return err
	}, "kind", j.Kind, "job", j.ID)
}

// recordOutcome makes write, the store write that records what became of a
// job or a webhook delivery, trying again a few times when it fails. Work
// whose outcome is not recorded is done again later (a second mail, a
// second webhook call), so a write that still fails is logged as an error
// that says so. It reports whether the outcome was recorded.
func (s *Server) recordOutcome(ctx context.Context, what string, write func(context.Context) error, logArgs ...any) bool {
	pause := outcomePause
	var err error
	for try := range outcomeTries {
		if try > 0 {
			time.Sleep(pause)
			pause *= 2
		}
		if err = write(ctx); err == nil {
			return true
		}
	}
	s.log.Error(what+": what happened could not be recorded, so it may be done again", append(logArgs, "err", err)...)
	return false
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
// they have already read it. An item or a person that is gone is nothing
// to tell; a read that fails is an error, and the job is tried again.
func (s *Server) jobNotify(ctx context.Context, j core.Job) error {
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(j.Payload, &p); err != nil {
		return fmt.Errorf("the job's payload: %w", err)
	}
	db := s.st.In(j.WorkspaceID)
	var n core.Notification
	if there, err := store.Find(ctx, db, &n, store.Eq("id", p.ID)); err != nil || !there || n.ReadAt != 0 {
		return err
	}
	var u core.User
	if there, err := store.Find(ctx, s.st, &u, store.Eq("id", n.UserID), store.Live); err != nil || !there {
		return err
	}
	if u.Kind != core.KindPerson || u.DisabledAt != 0 {
		return nil // agents are woken through the feed and webhooks
	}
	var prefs notifyPrefs
	if len(u.Notify) > 0 {
		_ = json.Unmarshal(u.Notify, &prefs) //nolint:errcheck // choices that do not read are the defaults
	}
	var ws core.Workspace
	var actor core.Member
	if err := s.st.Get(ctx, &ws, store.Eq("id", j.WorkspaceID)); err != nil {
		return err
	}
	// An actor who is no longer a member is named by nobody.
	if _, err := store.Find(ctx, db, &actor, store.Eq("user_id", n.ActorID)); err != nil {
		return err
	}
	link := s.cfg.BaseURL + "/" + ws.Slug + "/inbox"
	if n.TaskID != "" {
		link = s.cfg.BaseURL + "/" + ws.Slug + "/task/" + strings.SplitN(n.Title, " ", 2)[0]
	} else if n.DocID != "" {
		link = s.cfg.BaseURL + "/" + ws.Slug + "/docs/" + n.DocID
	}
	title := strings.TrimSpace(actor.Name + " " + noteVerbs[n.Type] + " " + n.Title)

	// Tell by push and by mail, as the person chose.
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
