package server

import (
	"context"
	"time"
)

// Run does the server's background work until ctx ends: rolling cycles
// over, and whatever other files of this package add to runners.
func (s *Server) Run(ctx context.Context) {
	for _, r := range runners {
		go r(s, ctx)
	}
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		if err := s.eng.RollCycles(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("rolling cycles", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// runners are background loops started with the server.
var runners []func(s *Server, ctx context.Context)
