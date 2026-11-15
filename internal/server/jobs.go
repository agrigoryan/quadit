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

// Timing of jobs.
const (
	jobTick      = 2 * time.Second
	jobClaim     = 5 * time.Minute    // how long a claimed job is held; if its server dies, another takes over
	jobKeep      = 7 * 24 * time.Hour // finished jobs are kept this long for the health panel
	jobBatch     = 20                 // how many due jobs are read at a time
	jobMaxTries  = 5
	jobErrorSize = 500 // how much of a job's error is kept
)

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
// not added while the first still waits.
func (s *Server) enqueue(ctx context.Context, kind, workspaceID, dedupe string, payload any, runAt time.Time) {
	raw, _ := json.Marshal(payload) // the callers' payloads are plain values: always encodes
	j := core.Job{ID: id.New(), Kind: kind, WorkspaceID: workspaceID, Dedupe: dedupe, Payload: raw, RunAt: runAt.UnixMilli(), CreatedAt: time.Now().UnixMilli()}
	if err := s.st.Insert(ctx, j); err != nil && !errors.Is(err, store.ErrConflict) {
		s.log.Error("enqueue", "kind", kind, "err", err)
	}
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
	case j.Attempts+1 >= jobMaxTries || !ok:
		set["done_at"], set["error"] = time.Now().UnixMilli(), oneLine(jerr.Error(), jobErrorSize)
		s.log.Error("job gave up", "kind", j.Kind, "err", jerr)
	default:
		set["run_at"], set["error"] = time.Now().Add(backoff(j.Attempts+1)).UnixMilli(), oneLine(jerr.Error(), jobErrorSize)
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
	note, ok, err := s.readNotice(ctx, j)
	if err != nil || !ok {
		return err
	}
	return s.sendNotice(ctx, note)
}

// notice is an inbox item to tell its person about outside the app.
type notice struct {
	item  core.Notification
	user  core.User
	prefs notifyPrefs
	title string
	link  string
}

// readNotice reads what a notify job tells about, and to whom. It reports
// false when there is nothing to tell.
func (s *Server) readNotice(ctx context.Context, j core.Job) (notice, bool, error) {
	var note notice
	var p struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(j.Payload, &p); err != nil {
		return note, false, fmt.Errorf("the job's payload: %w", err)
	}
	db := s.st.In(j.WorkspaceID)
	n := &note.item
	if there, err := rowFound(db.Get(ctx, n, store.Eq("id", p.ID))); err != nil || !there || n.ReadAt != 0 {
		return note, false, err
	}
	u := &note.user
	if there, err := rowFound(s.st.Get(ctx, u, store.Eq("id", n.UserID), store.Live)); err != nil || !there {
		return note, false, err
	}
	if u.Kind != core.KindPerson || u.DisabledAt != 0 {
		return note, false, nil // agents are woken through the feed and webhooks
	}
	if len(u.Notify) > 0 {
		_ = json.Unmarshal(u.Notify, &note.prefs) //nolint:errcheck // choices that do not read are the defaults
	}
	var ws core.Workspace
	var actor core.Member
	if err := s.st.Get(ctx, &ws, store.Eq("id", j.WorkspaceID)); err != nil {
		return note, false, err
	}
	// An actor who is no longer a member is named by nobody.
	if _, err := rowFound(db.Get(ctx, &actor, store.Eq("user_id", n.ActorID))); err != nil {
		return note, false, err
	}
	note.link = s.cfg.BaseURL + "/" + ws.Slug + "/inbox"
	if n.TaskID != "" {
		note.link = s.cfg.BaseURL + "/" + ws.Slug + "/task/" + strings.SplitN(n.Title, " ", 2)[0]
	} else if n.DocID != "" {
		note.link = s.cfg.BaseURL + "/" + ws.Slug + "/docs/" + n.DocID
	}
	note.title = strings.TrimSpace(actor.Name + " " + noteVerbs[n.Type] + " " + n.Title)
	return note, true, nil
}

// sendNotice tells by push and by mail, as the person chose.
func (s *Server) sendNotice(ctx context.Context, note notice) error {
	n, u, prefs, title, link := note.item, note.user, note.prefs, note.title, note.link
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

// rowFound reads the error of a store Get used to ask whether a row is
// there: found, not there, or the read failed.
func rowFound(err error) (bool, error) {
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	return err == nil, err
}
