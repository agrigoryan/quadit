package hub

import (
	"context"
	"sync"
	"testing"
	"testing/synctest"
)

// waiter runs WaitSince in a goroutine and gives a channel with its answer.
func waiter(ctx context.Context, h *Hub, ws string, after int64, started int) <-chan bool {
	done := make(chan bool, 1)
	go func() { done <- h.WaitSince(ctx, ws, after, started) }()
	return done
}

func TestWaitReturnsAtOnceWhenTheFeedIsAlreadyPast(t *testing.T) {
	h := New()
	h.Notify("w", 5)
	if !h.Wait(t.Context(), "w", 4) {
		t.Fatal("no news reported for a feed already past")
	}
}

func TestAWaiterIsWokenByNews(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := New()
		done := waiter(t.Context(), h, "w", 0, -1)
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("returned before any news")
		default:
		}
		h.Notify("other", 1) // another workspace's news does not wake it
		synctest.Wait()
		select {
		case <-done:
			t.Fatal("woken by another workspace")
		default:
		}
		h.Notify("w", 1)
		if !<-done {
			t.Fatal("woken without news")
		}
	})
}

func TestAWaiterIsWokenByAPoke(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := New()
		done := waiter(t.Context(), h, "w", 0, -1)
		synctest.Wait()
		h.PokeAll()
		if !<-done {
			t.Fatal("a poke did not count as a reason to look again")
		}
	})
}

func TestAPokeBetweenReadingAndWaitingIsNotMissed(t *testing.T) {
	h := New()
	started := h.Pokes("w") // read before the caller's own check
	h.PokeAll()             // the poke lands before the caller waits
	if !h.WaitSince(t.Context(), "w", 0, started) {
		t.Fatal("the poke before the wait was missed")
	}
}

func TestAWaitEndsWithItsContext(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := New()
		ctx, cancel := context.WithCancel(t.Context())
		done := waiter(ctx, h, "w", 0, -1)
		synctest.Wait()
		cancel()
		if <-done {
			t.Fatal("reported news when the context ended")
		}
	})
}

func TestManyWaitersAreAllWoken(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := New()
		const n = 50
		var wg sync.WaitGroup
		results := make(chan bool, n)
		for i := range n {
			ws := "a"
			if i%2 == 1 {
				ws = "b"
			}
			wg.Go(func() { results <- h.Wait(t.Context(), ws, 0) })
		}
		synctest.Wait()
		h.Notify("a", 1)
		h.Notify("b", 1)
		wg.Wait()
		close(results)
		for got := range results {
			if !got {
				t.Fatal("a waiter returned with no news")
			}
		}
	})
}

func TestAnyIsClosedByAMove(t *testing.T) {
	h := New()
	moved := h.Any()
	h.Notify("w", 1)
	select {
	case <-moved:
	default:
		t.Fatal("Any was not closed by a move")
	}
	if h.Seq("w") != 1 {
		t.Fatalf("Seq = %d", h.Seq("w"))
	}
	h.Notify("w", 1) // no move: the next channel stays open
	select {
	case <-h.Any():
		t.Fatal("closed with no move")
	default:
	}
}
