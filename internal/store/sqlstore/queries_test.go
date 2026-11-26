package sqlstore

import (
	"context"
	"slices"
	"testing"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/store"
)

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

// TestTasksAreFoundByTheirEstimateOrItsAbsence: a list of estimates finds
// the tasks with one of them, 0 being one; none finds those without.
func TestTasksAreFoundByTheirEstimateOrItsAbsence(t *testing.T) {
	eachDB(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		db := s.In(fillTasks(t, s, 4))
		var tasks []core.Task
		if err := db.List(ctx, &tasks, store.Q{Order: "id"}); err != nil {
			t.Fatal(err)
		}
		// The four tasks: none, 0, 3 and 5.
		for i, estimate := range []any{nil, 0, 3, 5} {
			if _, err := db.Update(ctx, "tasks", map[string]any{"estimate": estimate}, store.Eq("id", tasks[i].ID)); err != nil {
				t.Fatal(err)
			}
		}
		for _, c := range []struct {
			name   string
			filter store.TaskFilter
			want   []int // the tasks found, by their place above
		}{
			{"some estimates", store.TaskFilter{Estimates: []int{0, 5}}, []int{1, 3}},
			{"none", store.TaskFilter{NoEstimate: true}, []int{0}},
			{"none, or one of them", store.TaskFilter{NoEstimate: true, Estimates: []int{3}}, []int{0, 2}},
			{"not asked", store.TaskFilter{}, []int{0, 1, 2, 3}},
		} {
			c.filter.Sort = "created"
			got, err := db.Tasks(ctx, c.filter)
			if err != nil {
				t.Fatal(err)
			}
			var found []int
			for _, task := range got {
				found = append(found, slices.IndexFunc(tasks, func(one core.Task) bool { return one.ID == task.ID }))
			}
			if !slices.Equal(found, c.want) {
				t.Errorf("%s: found %v, want %v", c.name, found, c.want)
			}
		}
	})
}
