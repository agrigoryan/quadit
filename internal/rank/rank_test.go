package rank

import (
	"math/rand"
	"sort"
	"testing"
)

func TestBetweenKeepsOrder(t *testing.T) {
	cases := [][2]string{{"", ""}, {"", "i"}, {"i", ""}, {"a", "b"}, {"a", "a1"}, {"az", "b"}, {"", "1"}, {"", "01"}, {"zz", ""}, {"0000000sg", "0000001kw"}}
	for _, c := range cases {
		m := Between(c[0], c[1])
		if !(m > c[0]) || (c[1] != "" && !(m < c[1])) {
			t.Errorf("Between(%q, %q) = %q: out of order", c[0], c[1], m)
		}
		if !Valid(m) {
			t.Errorf("Between(%q, %q) = %q: not valid", c[0], c[1], m)
		}
	}
}

func TestRandomInsertsStaySorted(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	ranks := []string{Between("", "")}
	for i := 0; i < 3000; i++ {
		at := r.Intn(len(ranks) + 1) // insert before index at
		lo, hi := "", ""
		if at > 0 {
			lo = ranks[at-1]
		}
		if at < len(ranks) {
			hi = ranks[at]
		}
		m := Between(lo, hi)
		ranks = append(ranks, "")
		copy(ranks[at+1:], ranks[at:])
		ranks[at] = m
	}
	if !sort.StringsAreSorted(ranks) {
		t.Fatal("ranks are not sorted after random inserts")
	}
	for i := 1; i < len(ranks); i++ {
		if ranks[i] == ranks[i-1] {
			t.Fatalf("duplicate rank %q", ranks[i])
		}
	}
}

func TestForNumberSortsAndLeavesRoom(t *testing.T) {
	prev := ""
	for n := 1; n <= 5000; n++ {
		s := ForNumber(n)
		if len(s) != 10 || s <= prev || !Valid(s) {
			t.Fatalf("ForNumber(%d) = %q after %q", n, s, prev)
		}
		if prev != "" {
			if m := Between(prev, s); !(m > prev && m < s) {
				t.Fatalf("no room between %q and %q", prev, s)
			}
		}
		prev = s
	}
}
