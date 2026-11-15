// Package hub wakes whoever waits for news in a workspace: held requests,
// live streams and the background dispatcher. It carries no data, only "the
// feed moved to N"; waiters then read the feed from the database. That keeps
// the database the one source of truth, which several servers can share.
package hub

import (
	"context"
	"sync"
)

// room is one workspace's place in the hub: how far its feed is, and the
// channel its waiters block on.
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

// New makes an empty hub; a workspace's room is made the first time it is
// named.
func New() *Hub {
	return &Hub{rooms: map[string]*room{}, any: make(chan struct{})}
}

// room gives the workspace's room, making it if needed. The caller holds mu.
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
	return h.WaitSince(ctx, ws, after, -1)
}

// Pokes is how many times a workspace's waiters have been told to look
// again. A caller that checks something first and waits after reads it
// before the check and hands it to WaitSince, so that a poke falling
// between the two is not lost.
func (h *Hub) Pokes(ws string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.room(ws).pokes + h.pokes
}

// WaitSince is Wait that also returns at once when there has been a poke
// since the count the caller read (see Pokes); -1 counts from now.
func (h *Hub) WaitSince(ctx context.Context, ws string, after int64, started int) bool {
	// Each pass reads the room's state and its wake channel together, so a
	// move or a poke after the read closes the channel waited on.
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
