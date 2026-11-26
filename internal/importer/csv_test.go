package importer

import (
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

// writeFile writes text to a file of that name in a new folder.
func writeFile(t *testing.T, name, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// titleAndNotes makes a task of the "Title" and "Notes" columns, or of
// "Name" when there is no title.
func titleAndNotes(get csvCells) Task {
	return Task{Title: get("title", "name"), Description: get("notes")}
}

func TestReadCSV(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []Task
	}{
		{"a byte order mark and spaces in the header", "\ufeff Title ,Notes\nOne,first\n", []Task{{Title: "One", Description: "first"}}},
		{"rows shorter and longer than the header", "Title,Notes\nOne\nTwo,second,extra\n", []Task{{Title: "One"}, {Title: "Two", Description: "second"}}},
		{"quoted fields with commas, quotes and lines", "Title,Notes\n\"One, two\",\"said \"\"hi\"\"\nand left\"\n", []Task{{Title: "One, two", Description: "said \"hi\"\nand left"}}},
		{"a stray quote", "Title,Notes\nOne,6\" tall\n", []Task{{Title: "One", Description: "6\" tall"}}},
		{"a row with no title is skipped", "Title,Notes\n,orphan\n  ,blank\nOne,kept\n", []Task{{Title: "One", Description: "kept"}}},
		{"the first named column with a value", "Name,Title\nfrom name,\nfrom name,from title\n", []Task{{Title: "from name"}, {Title: "from title"}}},
		{"a header only", "Title,Notes\n", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan, err := readCSV(writeFile(t, "export.csv", tc.text), "test", titleAndNotes)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Source != "test" || !reflect.DeepEqual(plan.Tasks, tc.want) {
				t.Fatalf("got %q %+v, want %+v", plan.Source, plan.Tasks, tc.want)
			}
		})
	}
}

func TestReadCSVFailures(t *testing.T) {
	t.Run("no file", func(t *testing.T) {
		if _, err := readCSV(filepath.Join(t.TempDir(), "none.csv"), "test", titleAndNotes); err == nil {
			t.Fatal("no error for a file that is not there")
		}
	})
	t.Run("an empty file has no header", func(t *testing.T) {
		if _, err := readCSV(writeFile(t, "empty.csv", ""), "test", titleAndNotes); err == nil {
			t.Fatal("no error for an empty file")
		}
	})
}

func TestLinearRow(t *testing.T) {
	text := "ID,Title,Status,Priority,Estimate,Labels,Canceled,Completed,Started\n" +
		"ENG-1,Half,Todo,High,2.5,\"a,b\",,,\n" +
		"ENG-2,None,In Progress,,,,,,\n" +
		"ENG-3,Gone,Todo,Urgent,x,,2024-01-01,,\n" +
		"ENG-4,Begun,Todo,,,,,,2024-01-01\n" +
		"ENG-5,Zero,Todo,,0,,,,\n" +
		"ENG-6,Sized,Todo,,xl,,,,\n"
	plan, err := readCSV(writeFile(t, "linear.csv", text), "linear", linearRow)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		category string
		priority int
		estimate string // "none" or the number
		labels   []string
	}{
		{"unstarted", 2, "2", []string{"a", "b"}},
		{"started", 0, "none", nil},
		{"canceled", 1, "none", nil},
		{"started", 0, "none", nil},
		{"unstarted", 0, "0", nil},
		{"unstarted", 0, "8", nil},
	}
	if len(plan.Tasks) != len(want) {
		t.Fatalf("%d tasks", len(plan.Tasks))
	}
	for i, w := range want {
		got := plan.Tasks[i]
		estimate := "none"
		if got.Estimate != nil {
			estimate = strconv.Itoa(*got.Estimate)
		}
		if got.Category != w.category || got.Priority != w.priority || estimate != w.estimate || !reflect.DeepEqual(got.Labels, w.labels) {
			t.Errorf("%s: got %+v", got.Ext, got)
		}
	}
}
