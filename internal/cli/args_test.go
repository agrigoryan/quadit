package cli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSplitFields(t *testing.T) {
	cases := []struct {
		name   string
		args   []string
		pos    []string
		fields map[string][]string
	}{
		{"positional only", []string{"SVA-1", "fix", "it"}, []string{"SVA-1", "fix", "it"}, map[string][]string{}},
		{"field=value", []string{"SVA-1", "status=done"}, []string{"SVA-1"}, map[string][]string{"status": {"done"}}},
		{"a repeated key keeps every value in order", []string{"file=a.png", "file=b.png"}, nil, map[string][]string{"file": {"a.png", "b.png"}}},
		{"a value with = inside", []string{"q=a=b"}, nil, map[string][]string{"q": {"a=b"}}},
		{"an empty value", []string{"labels="}, nil, map[string][]string{"labels": {""}}},
		{"no key is positional", []string{"=x"}, []string{"=x"}, map[string][]string{}},
		{"a URL with = is positional", []string{"https://x.test/?a=b"}, []string{"https://x.test/?a=b"}, map[string][]string{}},
		{"a path with = is positional", []string{"dir/a=b.txt"}, []string{"dir/a=b.txt"}, map[string][]string{}},
		{"words with = are positional", []string{"a b=c"}, []string{"a b=c"}, map[string][]string{}},
		{"- is a value", []string{"description=-"}, nil, map[string][]string{"description": {"-"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pos, fields := splitFields(tc.args)
			if !reflect.DeepEqual(pos, tc.pos) || !reflect.DeepEqual(fields, tc.fields) {
				t.Fatalf("got %q %q, want %q %q", pos, fields, tc.pos, tc.fields)
			}
		})
	}
}

func TestReadInputTakesTheApprovalOutOfTheFields(t *testing.T) {
	in := readInput("update", []string{"SVA-1", "approval=D9", "status=done"})
	if in.approval != "D9" {
		t.Fatalf("approval %q", in.approval)
	}
	if _, ok := in.f["approval"]; ok {
		t.Fatal("approval is still one of the fields")
	}
	if !reflect.DeepEqual(in.pos, []string{"SVA-1"}) || in.f["status"][0] != "done" {
		t.Fatalf("input %+v", in)
	}
}

func TestAPIValue(t *testing.T) {
	cases := []struct {
		key, value string
		want       any
	}{
		{"title", "hello", "hello"},
		{"title", "null", nil},
		{"assignee", "none", nil},
		{"assignee", "Nobody", nil},
		{"assignee", "-", nil},
		{"assignee", "", nil},
		{"assignee", "@ann", "@ann"},
		{"priority", "high", 2},
		{"priority", "None", 0},
		{"priority", "3", 3},
		{"priority", "soon", "soon"},
		{"estimate", "5", 5},
		{"estimate", "5.5", "5.5"},
		{"estimate", "0", 0},
		{"estimate", "M", "M"},
		{"estimate", "none", nil},
		{"estimate", "-", nil},
		{"title", "5", "5"},
		{"labels", "a,b", []string{"a", "b"}},
		{"labels", "", []string{}},
		{"archived", "yes", true},
		{"archived", "TRUE", true},
		{"archived", "0", false},
		{"archived", "off", false},
		{"archived", "maybe", "maybe"},
		{"labels", "null", nil},
	}
	for _, tc := range cases {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			if got := apiValue(tc.key, tc.value); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

// withStdin makes standard input the file at path, opened with flag, for
// the length of the test.
func withStdin(t *testing.T, path string, flag int) {
	t.Helper()
	f, err := os.OpenFile(path, flag, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	was := os.Stdin
	os.Stdin = f
	t.Cleanup(func() {
		os.Stdin = was
		f.Close()
	})
}

func TestArgsFrom(t *testing.T) {
	t.Run("the last of a repeated field counts", func(t *testing.T) {
		got, err := argsFrom(map[string][]string{"status": {"todo", "done"}})
		if err != nil || got["status"] != "done" {
			t.Fatalf("got %v, %v", got, err)
		}
	})
	t.Run("skipped fields are left out", func(t *testing.T) {
		got, err := argsFrom(map[string][]string{"why": {"x"}, "title": {"t"}}, "why", "file")
		if err != nil || !reflect.DeepEqual(got, map[string]any{"title": "t"}) {
			t.Fatalf("got %v, %v", got, err)
		}
	})
	t.Run("values are what the API takes", func(t *testing.T) {
		got, err := argsFrom(map[string][]string{"priority": {"urgent"}, "labels": {"a,b"}, "assignee": {"none"}})
		want := map[string]any{"priority": 1, "labels": []string{"a", "b"}, "assignee": nil}
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("got %#v, %v", got, err)
		}
	})
	t.Run("description=- is read from stdin", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "in.md")
		if err := os.WriteFile(path, []byte("from stdin\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		withStdin(t, path, os.O_RDONLY)
		got, err := argsFrom(map[string][]string{"description": {"-"}, "title": {"-"}})
		if err != nil || got["description"] != "from stdin\n" || got["title"] != "-" {
			t.Fatalf("got %#v, %v", got, err)
		}
	})
	t.Run("stdin that cannot be read is an error", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "out")
		withStdin(t, path, os.O_WRONLY|os.O_CREATE)
		got, err := argsFrom(map[string][]string{"body": {"-"}})
		if err == nil || !strings.Contains(err.Error(), "body=-") {
			t.Fatalf("got %#v, %v; want an error naming body=-", got, err)
		}
	})
}

func TestFieldsInOrderKeepsTheOrderTyped(t *testing.T) {
	got := fieldsInOrder([]string{"SVA-1", "Which?", "file=q.png", "option=A", "file=a.png", "why=x", "option=B::the other", "file=b.png"})
	want := []field{{"file", "q.png"}, {"option", "A"}, {"file", "a.png"}, {"why", "x"}, {"option", "B::the other"}, {"file", "b.png"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
	labels, files := questionParts(got)
	if !reflect.DeepEqual(labels, []string{"A", "B::the other"}) {
		t.Fatalf("labels %q", labels)
	}
	wantFiles := []askFile{{"q.png", 0}, {"a.png", 1}, {"b.png", 2}}
	if !reflect.DeepEqual(files, wantFiles) {
		t.Fatalf("files %+v", files)
	}
	opts := options(labels)
	if opts[1]["label"] != "B" || opts[1]["description"] != "the other" || opts[0]["description"] != nil {
		t.Fatalf("options %v", opts)
	}
}

// TestTheSwitchesOfACommandToRunAreItsOwn: after --exec or --, a switch is
// the command's: listen --workspace=acme --exec npm run job
// --workspace=frontend listens in acme and runs npm with its own.
func TestTheSwitchesOfACommandToRunAreItsOwn(t *testing.T) {
	sw, rest := takeSwitches([]string{"listen", "--workspace=acme", "--exec", "npm", "run", "job", "--workspace=frontend", "--json"})
	if sw != (switches{workspace: "acme"}) || !reflect.DeepEqual(rest, []string{"listen", "--exec", "npm", "run", "job", "--workspace=frontend", "--json"}) {
		t.Fatalf("switches %+v, rest %q", sw, rest)
	}
}

func TestTakeSwitches(t *testing.T) {
	sw, rest := takeSwitches([]string{"--json", "update", "--id=abc", "SVA-1", "--for=@ann", "--dry-run", "status=done", "--", "--json"})
	want := switches{json: true, dry: true, changeID: "abc", actFor: "@ann"}
	if sw != want {
		t.Fatalf("switches %+v", sw)
	}
	if !reflect.DeepEqual(rest, []string{"update", "SVA-1", "status=done", "--", "--json"}) {
		t.Fatalf("rest %q", rest)
	}
}
