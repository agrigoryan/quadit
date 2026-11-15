// Package id makes and checks the identifiers used for every row.
//
// Ids are UUIDv7: 48 bits of Unix milliseconds followed by random bits, so
// they sort by creation time and can be made on a client before the server has
// seen the row. A counter in the random part keeps ids made in the same
// millisecond by one process in order.
package id

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sync"
	"time"
)

var (
	mu       sync.Mutex
	lastMS   int64
	lastRand uint16 // 12-bit counter placed in rand_a
)

// New returns a new UUIDv7 in the canonical lower-case form.
func New() string {
	return NewAt(time.Now())
}

// NewAt returns a UUIDv7 for the given time. Ids for the same or an earlier
// millisecond than the previous call still sort after it.
func NewAt(t time.Time) string {
	var b [16]byte
	if _, err := rand.Read(b[6:]); err != nil {
		panic("id: no randomness: " + err.Error())
	}

	mu.Lock()
	ms := t.UnixMilli()
	seq := binary.BigEndian.Uint16(b[6:8]) & 0x0fff
	if ms <= lastMS {
		ms = lastMS
		seq = lastRand + 1
		if seq > 0x0fff { // counter full: borrow the next millisecond
			ms++
			seq = 0
		}
	}
	lastMS, lastRand = ms, seq
	mu.Unlock()

	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = 0x70 | byte(seq>>8) // version 7
	b[7] = byte(seq)
	b[8] = 0x80 | (b[8] & 0x3f) // variant 10

	var out [36]byte
	hex.Encode(out[0:8], b[0:4])
	out[8] = '-'
	hex.Encode(out[9:13], b[4:6])
	out[13] = '-'
	hex.Encode(out[14:18], b[6:8])
	out[18] = '-'
	hex.Encode(out[19:23], b[8:10])
	out[23] = '-'
	hex.Encode(out[24:36], b[10:16])
	return string(out[:])
}

// Valid reports whether s is a canonical lower-case UUID of any version.
// Clients make their own ids, so every id that arrives from outside is checked.
func Valid(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := range 36 {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
				return false
			}
		}
	}
	return true
}

// From returns the same id for the same parts every time. It is used where
// doing something twice must be recognized as the same thing.
func From(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	b := h.Sum(nil)[:16]
	b[6] = (b[6] & 0x0f) | 0x70 // version 7 layout, so it passes as an id
	b[8] = (b[8] & 0x3f) | 0x80
	x := hex.EncodeToString(b)
	return x[:8] + "-" + x[8:12] + "-" + x[12:16] + "-" + x[16:20] + "-" + x[20:]
}
