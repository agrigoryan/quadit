package formula

import (
	"strings"
	"testing"
	"time"
)

func TestEval(t *testing.T) {
	row := map[string]any{"Points": 3.0, "Done": false, "Owner": "aram", "Due": "2026-11-20", "Tags": []any{"art", "bug"}}
	env := Env{Prop: func(n string) any { return row[n] }, Now: time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)}
	for src, want := range map[string]any{
		`1 + 2 * 3`:                       7.0,
		`(1 + 2) * 3`:                     9.0,
		`round(prop("Points") * 1.55, 1)`: 4.7,
		`if(prop("Done"), "shipped", concat(prop("Owner"), " is on it"))`: "aram is on it",
		`dateDiff(prop("Due"), today(), "days")`:                          6.0,
		`dateDiff(prop("Due"), today()) < 7 and not prop("Done")`:         true,
		`dateAdd(prop("Due"), 2, "weeks")`:                                "2026-12-04",
		`"total: " + 4`:                                                   "total: 4",
		`empty(prop("Missing")) or 1 / 0`:                                 true,
		`length(prop("Owner")) == 4`:                                      true,
		`max(1, 5, 3) - min(4, 2)`:                                        3.0,
		`sum(prop("Missing"), 2, 3)`:                                      5.0,
		`contains(format(prop("Tags")), "BUG")`:                           true,
		`-prop("Points") % 2`:                                             -1.0,
	} {
		got, err := Eval(src, env)
		if err != nil || got != want {
			t.Errorf("%s = %v (%v), want %v", src, got, err, want)
		}
	}
	for src, want := range map[string]string{
		`nope(1)`:    "unknown function nope",
		`Points + 1`: `prop("Points")`,
		`"open`:      "closing quote",
		`if(true, 1`: "missing its )",
		`1 +`:        "ends too soon",
		`"abc" * 2`:  "not a number",
	} {
		if _, err := Eval(src, env); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: error %v, want one mentioning %q", src, err, want)
		}
	}
}
