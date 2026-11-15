// Work a request starts and does not wait for: the mail it sends, the sync
// a webhook asks for. The server owns it, so that stopping waits for it.

package server

import (
	"context"
	"sync"
	"time"
)

// detachedLimit is how long work left running after an answer may take.
const detachedLimit = 2 * time.Minute

// detached is the work requests left running after their answer. Run waits
// for it before it returns; the caller of Run bounds how long that may be.
type detached struct {
	mu       sync.Mutex
	running  sync.WaitGroup
	stopping bool // Run is waiting: work is done before the answer instead
}

// detach runs work after the request that starts it has answered, with
// parent's values and a context that does not end with the request, cut
// off after detachedLimit. While the server stops, the work is done before
// detach returns, so that none is started that nobody waits for.
func (s *Server) detach(parent context.Context, work func(ctx context.Context)) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), detachedLimit)
	d := &s.detached
	d.mu.Lock()
	stopping := d.stopping
	if !stopping {
		d.running.Add(1)
	}
	d.mu.Unlock()
	if stopping {
		defer cancel()
		work(ctx)
		return
	}
	go func() {
		defer d.running.Done()
		defer cancel()
		work(ctx)
	}()
}

// waitForDetached waits for the work requests left running.
func (s *Server) waitForDetached() {
	d := &s.detached
	d.mu.Lock()
	d.stopping = true
	d.mu.Unlock()
	d.running.Wait()
}
