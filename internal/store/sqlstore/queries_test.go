package sqlstore

import "testing"

func TestALimitAboveTheMostGivesTheMost(t *testing.T) {
	for _, tc := range []struct{ asked, want int }{
		{0, defaultTaskLimit},
		{-1, defaultTaskLimit},
		{1, 1},
		{maxTaskLimit, maxTaskLimit},
		{maxTaskLimit + 1, maxTaskLimit},
	} {
		if got := limitOr(tc.asked, defaultTaskLimit, maxTaskLimit); got != tc.want {
			t.Errorf("a limit of %d gives %d, want %d", tc.asked, got, tc.want)
		}
	}
}
