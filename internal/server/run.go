package server

import (
	"context"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
)

// Run does the server's background work until ctx ends: rolling cycles
// over, and whatever other files of this package add to runners.
func (s *Server) Run(ctx context.Context) {
	var fc blob.Config
	if s.setting(ctx, "files", &fc) {
		if err := s.useFiles(ctx, fc); err != nil {
			s.log.Error("file storage is not usable as set; files stay on local disk until it is fixed", "err", err)
		}
	}
	s.applyLimits(ctx)
	for _, r := range runners {
		go r(s, ctx)
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

// runners are background loops started with the server.
var runners []func(s *Server, ctx context.Context)

func init() {
	// files.move copies files left on local disk into the cloud store.
	jobKinds["files.move"] = func(s *Server, ctx context.Context, j core.Job) error {
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
}
