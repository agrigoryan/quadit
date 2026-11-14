// Package rank makes the strings that keep rows in manual order.
//
// A rank is a string over 0-9a-z compared byte by byte. To move a row
// between two others, give it a rank between theirs: no other row changes,
// so a reorder is one small write that merges cleanly with other people's.
// Strings work the same in every database, which floats do not.
package rank

import "strings"

const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
const base = len(digits)

// Between returns a rank that sorts after a and before b. An empty a means
// "before everything", an empty b "after everything". It panics if a >= b,
// which is a bug in the caller.
func Between(a, b string) string {
	if b != "" && a >= b {
		panic("rank: Between(" + a + ", " + b + "): not in order")
	}
	var out strings.Builder
	for i := 0; ; i++ {
		lo := 0
		if i < len(a) {
			lo = strings.IndexByte(digits, a[i])
		}
		hi := base
		if b != "" && i < len(b) {
			hi = strings.IndexByte(digits, b[i])
		}
		if lo < 0 || hi < 0 {
			panic("rank: not a rank: " + a + " / " + b)
		}
		if hi-lo > 1 {
			out.WriteByte(digits[(lo+hi)/2])
			return out.String()
		}
		// No room at this digit: keep a's digit and look further right. Once
		// the result is below b here, only a still bounds it.
		out.WriteByte(digits[lo])
		if hi-lo == 1 {
			b = ""
		}
	}
}

// After returns a rank that sorts after a.
func After(a string) string { return Between(a, "") }

// Before returns a rank that sorts before b.
func Before(b string) string { return Between("", b) }

// ForNumber returns the rank a new row gets when it is added at the end and
// rows are numbered 1, 2, 3... Ranks made this way have one width, sort in
// number order, and leave room between neighbours for later moves, so
// appending never makes ranks longer.
func ForNumber(n int) string {
	if n < 0 {
		n = 0
	}
	v := uint64(n) << 10
	if v%uint64(base) == 0 {
		v++ // a rank never ends in 0: nothing could be placed before it
	}
	var b [10]byte
	for i := len(b) - 1; i >= 0; i-- {
		b[i] = digits[v%uint64(base)]
		v /= uint64(base)
	}
	return string(b[:])
}

// Valid reports whether s can be used as a rank.
func Valid(s string) bool {
	if s == "" || s[len(s)-1] == '0' {
		return false // a trailing 0 leaves no room before it
	}
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(digits, s[i]) < 0 {
			return false
		}
	}
	return true
}
