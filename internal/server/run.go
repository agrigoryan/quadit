package server

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// Background work: Run, the lists of loops it starts and of kinds of
// job, and the loops and the job that belong to no other file.

// Run does the server's background work until ctx ends. It first switches
// file storage to what the "files" setting says and applies the rate-limit
// setting, then starts each loop in runners in a goroutine of its own, and
// itself rolls cycles over every hour and expires quiet holds on shared
// resources every minute.
//
// When ctx ends Run returns once every loop it started has returned, so
// the caller may then close the store. A loop in the middle of a piece of
// work (a job, a webhook delivery, a repository sync) ends it at its next
// look at ctx, and records what became of it first; outbound requests see
// ctx end and are cut off.
func (s *Server) Run(ctx context.Context) {
	var fc blob.Config
	if s.setting(ctx, "files", &fc) {
		if err := s.useFiles(ctx, fc); err != nil {
			s.log.Error("file storage is not usable as set; files stay on local disk until it is fixed", "err", err)
		}
	}
	s.applyLimits(ctx)
	defer s.waitForDetached()
	var loops sync.WaitGroup
	defer loops.Wait()
	for _, r := range runners {
		loops.Go(func() { r(s, ctx) })
	}
	hourly := time.NewTicker(time.Hour)
	defer hourly.Stop()
	minutely := time.NewTicker(time.Minute)
	defer minutely.Stop()
	for {
		if err := s.eng.RollCycles(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("rolling cycles", "err", err)
		}
	wait:
		for {
			select {
			case <-ctx.Done():
				return
			case <-hourly.C:
				break wait
			case <-minutely.C:
				// A shared resource whose holder went quiet goes to the next in line.
				if err := s.eng.ExpireHolds(ctx); err != nil && ctx.Err() == nil {
					s.log.Error("expiring holds", "err", err)
				}
			}
		}
	}
}

// runners are the background loops Run starts, each in a goroutine of its
// own. Each runs until ctx ends; Run waits for them to return.
var runners = []func(s *Server, ctx context.Context){
	(*Server).hearOtherServers, // below: writes made through another server
	(*Server).shareRateCounts,  // below: rate limits across servers
	(*Server).runDispatcher,    // dispatch.go: events into wake-ups
	(*Server).runDeliveries,    // deliveries.go: webhook deliveries
	(*Server).runJobs,          // jobs.go: the jobs below, when due
	(*Server).runSchedule,      // backups.go: backups and emptying the trash, on schedule
	(*Server).runGitHub,        // github.go: GitHub integrations, on their timer
	func(s *Server, ctx context.Context) { s.repos.Run(ctx) }, // package reposync: repository sources, on their timer
}

// jobKinds maps a kind of job to what runs it (jobs.go runs them).
var jobKinds = map[string]func(s *Server, ctx context.Context, j core.Job) error{
	"notify":      (*Server).jobNotify,
	"backup":      (*Server).jobBackup,
	"trash.purge": (*Server).jobPurgeTrash,
	"files.move":  (*Server).jobMoveFiles,
}

// jobMoveFiles copies files left on local disk into the cloud store.
func (s *Server) jobMoveFiles(ctx context.Context, _ core.Job) error {
	l, ok := s.fileStore().(blob.Layered)
	if !ok {
		return nil
	}
	n, err := blob.Move(ctx, l.Old, l.Primary)
	if n > 0 {
		s.log.Info("moved files to the cloud store", "files", n)
	}
	return err
}

// hearOtherServers wakes this server's waiters when a write was made
// through another server sharing the database. Live connections are fed
// from the feed, not from the process that took the write.
func (s *Server) hearOtherServers(ctx context.Context) {
	l, ok := s.st.(store.Listener)
	if !ok {
		return
	}
	for ctx.Err() == nil {
		err := l.Listen(ctx, func(ws string, seq int64) {
			if seq < 0 {
				s.hub.PokeAll()
				return
			}
			s.hub.Notify(ws, seq)
		})
		if errors.Is(err, store.ErrNoListen) || ctx.Err() != nil {
			return
		}
		s.log.Warn("lost the connection that hears other servers; connecting again", "err", err)
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}

// shareRateCounts adds this server's request counts to the database every
// couple of seconds and reads back the totals, so a caller's limit holds
// across all the servers they reach.
func (s *Server) shareRateCounts(ctx context.Context) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.limits.shareCounts(ctx, s.st)
		}
	}
}
