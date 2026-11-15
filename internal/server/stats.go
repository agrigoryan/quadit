package server

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// stats counts requests for the metrics endpoint.
type stats struct {
	mu       sync.Mutex
	requests map[string]int64 // "METHOD class"
	seconds  float64
	started  time.Time
}

func (s *stats) observe(r *http.Request, status int, d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.requests == nil {
		s.requests, s.started = map[string]int64{}, time.Now()
	}
	s.requests[fmt.Sprintf("%s %dxx", r.Method, status/100)]++
	s.seconds += d.Seconds()
}
