package server

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

// limiter is a fixed-window request counter per caller. It lives in memory:
// one server is one limit, and several servers each allow their own share.
type limiter struct {
	mu     sync.Mutex
	window int64 // the minute being counted, in minutes since 1970
	// hits are the requests counted here since the last time they were
	// added to the database; shared are the totals read back from it, which
	// include every server's.
	hits   map[string]int
	shared map[string]int
	// factor scales every limit; applyLimits sets it from the admin area's
	// limits.api_per_minute.
	factor float64
}

// newLimiter makes a limiter that applies the limits as written.
func newLimiter() *limiter {
	return &limiter{hits: map[string]int{}, shared: map[string]int{}, factor: 1}
}

// shareCounts adds what was counted here to the database's counters and takes
// the totals back.
func (l *limiter) shareCounts(ctx context.Context, st store.Store) {
	l.mu.Lock()
	window, mine := l.window, l.hits
	l.hits = map[string]int{}
	l.mu.Unlock()
	totals := map[string]int{}
	for key, n := range mine {
		name := "api:" + key
		total, err := st.Incr(ctx, "rate_counters", "hits", int64(n), store.Eq("name", name), store.Eq("bucket", window))
		if errors.Is(err, store.ErrNotFound) {
			if err = st.Insert(ctx, core.RateCounter{Name: name, Bucket: window, Hits: n}); err == nil {
				total = int64(n)
			} else if errors.Is(err, store.ErrConflict) {
				total, err = st.Incr(ctx, "rate_counters", "hits", int64(n), store.Eq("name", name), store.Eq("bucket", window))
			}
		}
		if err != nil {
			total = int64(n) // the database is unwell: count what is known here
		}
		totals[key] = int(total)
	}
	if len(mine) > 0 {
		_, _ = st.Delete(ctx, "rate_counters", store.Like("name", "api:%"), store.Lt("bucket", window-1)) // best effort: old counters are deleted again in two seconds
	}
	// And what the other servers counted this minute, for every caller: a
	// caller this server has not seen lately may be busy on another.
	var rows []core.RateCounter
	if err := st.List(ctx, &rows, store.Q{Where: []store.Cond{store.Like("name", "api:%"), store.Eq("bucket", window)}, Limit: 5000}); err == nil {
		for _, r := range rows {
			key := strings.TrimPrefix(r.Name, "api:")
			if _, flushed := totals[key]; !flushed {
				totals[key] = r.Hits
			}
		}
	}
	l.mu.Lock()
	if l.window == window {
		maps.Copy(l.shared, totals)
	}
	l.mu.Unlock()
}

// check counts one request and refuses it when the caller is over
// perMinute (scaled by factor), saying how long to wait.
func (l *limiter) check(key string, perMinute int) error {
	now := time.Now().Unix()
	l.mu.Lock()
	defer l.mu.Unlock()
	if w := now / 60; w != l.window {
		l.window, l.hits, l.shared = w, map[string]int{}, map[string]int{}
	}
	l.hits[key]++
	if float64(l.hits[key]+l.shared[key]) > float64(perMinute)*l.factor {
		wait := int(60 - now%60)
		return &httpError{Status: 429, Code: "rate_limited", RetryAfter: wait,
			Message: fmt.Sprintf("too many requests; try again in %d seconds", wait)}
	}
	return nil
}
