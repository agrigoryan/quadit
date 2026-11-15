package app

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	Commands["backup"] = Backup
	Commands["restore"] = Restore
}

const backupHelp = `quadit backup [--out FILE]      write everything to one archive and verify it
quadit backup verify FILE       check an archive without restoring it
quadit restore FILE             load an archive into an empty install
quadit restore FILE --workspace SLUG --task KEY     bring back one task
quadit restore FILE --workspace SLUG --doc ID       bring back one page

The archive holds the database and the files together, and is the same on
SQLite and Postgres: it can be restored onto either. All take --data and
--db like "quadit serve".
`

// Backup writes an archive of the install, or verifies one.
func Backup(args []string, version string) int {
	if len(args) > 0 && args[0] == "verify" {
		if len(args) != 2 {
			fmt.Fprint(os.Stderr, backupHelp)
			return 2
		}
		f, err := os.Open(args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		defer f.Close()
		m, err := backup.Verify(f)
		if err != nil {
			fmt.Fprintln(os.Stderr, "not good:", err)
			return 1
		}
		rows := 0
		nfiles := 0
		for _, e := range m.Entries {
			rows += e.Rows
			if strings.HasPrefix(e.Name, "files/") {
				nfiles++
			}
		}
		fmt.Printf("good: made %s by version %s on %s; %d rows, %d files\n", time.UnixMilli(m.CreatedAt).UTC().Format(time.RFC3339), m.Version, m.Database, rows, nfiles)
		return 0
	}
	var o Options
	fs := flag.NewFlagSet("backup", flag.ExitOnError)
	o.registerFlags(fs)
	out := fs.String("out", "", "the file to write; default quadit-<time>.tar.gz in the current directory")
	fs.Usage = func() { fmt.Fprint(os.Stderr, backupHelp) }
	fs.Parse(args)
	ctx := context.Background()
	st, sealer, err := o.Open(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer st.Close()
	files, err := OpenFiles(ctx, st, sealer, o.Data)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	path := *out
	if path == "" {
		path = "quadit-" + time.Now().UTC().Format("20060102-150405") + ".tar.gz"
	}
	f, err := os.Create(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	_, err = backup.Write(ctx, st, files, version, f)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		var in *os.File
		if in, err = os.Open(path); err == nil {
			_, err = backup.Verify(in)
			in.Close()
		}
	}
	if err != nil {
		os.Remove(path)
		fmt.Fprintln(os.Stderr, "backup failed:", err)
		return 1
	}
	info, _ := os.Stat(path)
	fmt.Printf("%s written and verified (%d bytes)\n", path, info.Size())
	return 0
}

// Restore loads an archive: all of it into an empty install, or one task
// or page into a running one.
func Restore(args []string, version string) int {
	var o Options
	fs := flag.NewFlagSet("restore", flag.ExitOnError)
	o.registerFlags(fs)
	workspace := fs.String("workspace", "", "the workspace of the task or page to bring back")
	task := fs.String("task", "", "bring back one task, by key")
	doc := fs.String("doc", "", "bring back one page, by id")
	fs.Usage = func() { fmt.Fprint(os.Stderr, backupHelp) }
	// The archive may come before or after the flags.
	var file string
	var flags []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			flags = append(flags, args[i])
			if !strings.Contains(args[i], "=") && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		} else {
			file = args[i]
		}
	}
	fs.Parse(flags)
	if file == "" {
		fmt.Fprint(os.Stderr, backupHelp)
		return 2
	}
	ctx := context.Background()
	st, sealer, err := o.Open(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer st.Close()
	files, err := OpenFiles(ctx, st, sealer, o.Data)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	f, err := os.Open(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer f.Close()
	eng := engine.New(st)
	if *task != "" || *doc != "" {
		it := backup.Item{Workspace: *workspace, Kind: "task", Ref: *task}
		if *doc != "" {
			it.Kind, it.Ref = "doc", *doc
		}
		if it.Workspace == "" {
			fmt.Fprintln(os.Stderr, "say which workspace: --workspace SLUG")
			return 2
		}
		rid, err := backup.RestoreItem(ctx, st, files, f, it)
		if err != nil {
			fmt.Fprintln(os.Stderr, "restore failed:", err)
			return 1
		}
		// Tell open browsers, and put the text back in the search index.
		var ws core.Workspace
		if err := st.Get(ctx, &ws, store.Eq("slug", it.Workspace)); err == nil {
			if err := eng.AnnounceRestored(ctx, ws.ID, it.Kind, rid); err != nil {
				fmt.Fprintln(os.Stderr, "restored, but open browsers were not told:", err)
			}
			eng.Reindex(ctx, ws.ID)
			shellAudit(ctx, st, ws.ID, it.Kind+".restored_from_backup", it.Kind, rid, map[string]string{"archive": file})
		}
		fmt.Printf("brought back %s %s\n", it.Kind, it.Ref)
		return 0
	}
	m, err := backup.Restore(ctx, st, files, f)
	if err != nil {
		fmt.Fprintln(os.Stderr, "restore failed:", err)
		return 1
	}
	var wss []core.Workspace
	st.List(ctx, &wss, store.Q{})
	for _, ws := range wss {
		if err := eng.Reindex(ctx, ws.ID); err != nil {
			fmt.Fprintln(os.Stderr, "rebuilding search:", err)
		}
	}
	shellAudit(ctx, st, "", "install.restored_from_backup", "backup", "", map[string]string{"archive": file})
	fmt.Printf("restored the archive made %s: %d workspaces\n", time.UnixMilli(m.CreatedAt).UTC().Format(time.RFC3339), len(wss))
	return 0
}
