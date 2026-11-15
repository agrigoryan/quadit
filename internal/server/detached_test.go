package server

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// TestStoppingWaitsForDetachedWork: work a request leaves running after its
// answer is waited for when the server stops; work started while it stops
// is done at once, before the answer.
func TestStoppingWaitsForDetachedWork(t *testing.T) {
	s := &Server{}
	var done atomic.Int32
	release := make(chan struct{})
	s.detach(context.Background(), func(ctx context.Context) {
		<-release
		if ctx.Err() == nil {
			done.Add(1)
		}
	})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		s.waitForDetached()
	}()
	select {
	case <-stopped:
		t.Fatal("stopping did not wait for the work a request left running")
	case <-time.After(50 * time.Millisecond):
	}
	s.detach(context.Background(), func(context.Context) { done.Add(1) })
	if done.Load() != 1 {
		t.Fatal("work started while the server stops was not done before the answer")
	}
	close(release)
	<-stopped
	if done.Load() != 2 {
		t.Fatalf("%d pieces of work were done, want 2", done.Load())
	}
}
