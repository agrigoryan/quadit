// Package hub wakes whoever waits for news in a workspace: held requests,
// live streams and the background dispatcher. It carries no data, only "the
// feed moved to N"; waiters then read the feed from the database. That keeps
// the database the one source of truth, which several servers can share.
package hub

import (
	"context"
	"sync"
)

type room struct {
	seq   int64
	pokes int           // times waiters were woken with no news
	wake  chan struct{} // closed when seq moves, or on a poke
}

// Hub tracks the latest feed position seen per workspace.
type Hub struct {
	mu    sync.Mutex
	rooms map[string]*room
	any   chan struct{} // closed when any workspace moves
	pokes int           // times everyone was woken with no news
}

func New() *Hub {
	return &Hub{rooms: map[string]*room{}, any: make(chan struct{})}
}

func (h *Hub) room(ws string) *room {
	r := h.rooms[ws]
	if r == nil {
		r = &room{wake: make(chan struct{})}
		h.rooms[ws] = r
	}
	return r
}

// Notify says the workspace's feed reached seq.
func (h *Hub) Notify(ws string, seq int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.room(ws)
	if seq <= r.seq {
		return
	}
	r.seq = seq
	close(r.wake)
	r.wake = make(chan struct{})
	close(h.any)
	h.any = make(chan struct{})
}

// Wait returns when the workspace's feed is past after, or ctx ends. It
// reports whether there is news.
func (h *Hub) Wait(ctx context.Context, ws string, after int64) bool {
	started := -1
	for {
		h.mu.Lock()
		r := h.room(ws)
		seq, wake, pokes := r.seq, r.wake, r.pokes+h.pokes
		h.mu.Unlock()
		if started < 0 {
			started = pokes
		}
		if seq > after || pokes != started {
			return true
		}
		select {
		case <-wake:
		case <-ctx.Done():
			return false
		}
	}
}

// Any returns a channel closed the next time any workspace moves.
func (h *Hub) Any() <-chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.any
}

// Seq returns the latest position the hub has seen for a workspace.
func (h *Hub) Seq(ws string) int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.room(ws).seq
}

// PokeAll wakes everyone who waits, in every workspace, although no feed
// moved: something they should look at again has changed, such as who may
// still be connected.
func (h *Hub) PokeAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.pokes++
	for _, r := range h.rooms {
		close(r.wake)
		r.wake = make(chan struct{})
	}
}
