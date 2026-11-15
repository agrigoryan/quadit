// The backup and restore commands, run on the server's machine.

package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

func init() {
	Commands["backup"] = Backup
	Commands["restore"] = Restore
}

// backupHelp is the help of quadit backup and quadit restore.
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
		return verifyBackup(args[1:])
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
	size, err := writeVerified(path, func(w io.Writer) error {
		_, err := backup.Write(ctx, st, files, version, w)
		return err
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "backup failed:", err)
		return 1
	}
	fmt.Printf("%s written and verified (%d bytes)\n", path, size)
	return 0
}

// verifyBackup checks an archive without restoring it: quadit backup verify
// FILE.
func verifyBackup(args []string) int {
	if len(args) != 1 {
		fmt.Fprint(os.Stderr, backupHelp)
		return 2
	}
	f, err := os.Open(args[0])
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

// writeVerified writes an archive to path with write, reads it back to
// verify it, and gives its size. An archive that fails any of that is
// removed.
func writeVerified(path string, write func(io.Writer) error) (int64, error) {
	f, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	err = write(f)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		var in *os.File
		if in, err = os.Open(path); err == nil {
			_, err = backup.Verify(in)
			in.Close()
		}
	}
	var info os.FileInfo
	if err == nil {
		info, err = os.Stat(path)
	}
	if err != nil {
		os.Remove(path)
		return 0, err
	}
	return info.Size(), nil
}

// restoreArgs are what quadit restore was given.
type restoreArgs struct {
	o         Options
	file      string // the archive
	workspace string // with task or doc: the workspace it is in
	task, doc string // one task or page to bring back, if not everything
}

// parseRestoreArgs reads quadit restore's arguments. The archive may come
// before or after the flags.
func parseRestoreArgs(args []string) restoreArgs {
	var ra restoreArgs
	fs := flag.NewFlagSet("restore", flag.ExitOnError)
	ra.o.registerFlags(fs)
	fs.StringVar(&ra.workspace, "workspace", "", "the workspace of the task or page to bring back")
	fs.StringVar(&ra.task, "task", "", "bring back one task, by key")
	fs.StringVar(&ra.doc, "doc", "", "bring back one page, by id")
	fs.Usage = func() { fmt.Fprint(os.Stderr, backupHelp) }
	var flags []string
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") {
			ra.file = args[i]
			continue
		}
		flags = append(flags, args[i])
		if !strings.Contains(args[i], "=") && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	fs.Parse(flags)
	return ra
}

// Restore loads an archive: all of it into an empty install, or one task
// or page into a running one.
func Restore(args []string, _ string) int {
	ra := parseRestoreArgs(args)
	if ra.file == "" {
		fmt.Fprint(os.Stderr, backupHelp)
		return 2
	}
	ctx := context.Background()
	st, sealer, err := ra.o.Open(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer st.Close()
	files, err := OpenFiles(ctx, st, sealer, ra.o.Data)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	f, err := os.Open(ra.file)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer f.Close()
	if ra.task != "" || ra.doc != "" {
		return restoreItem(ctx, st, files, f, ra)
	}
	return restoreAll(ctx, st, files, f, ra.file)
}

// restoreItem brings one task or page back from the archive into a running
// install, and tells open browsers and the search index.
func restoreItem(ctx context.Context, st store.Store, files blob.Store, archive io.Reader, ra restoreArgs) int {
	it := backup.Item{Workspace: ra.workspace, Kind: "task", Ref: ra.task}
	if ra.doc != "" {
		it.Kind, it.Ref = "doc", ra.doc
	}
	if it.Workspace == "" {
		fmt.Fprintln(os.Stderr, "say which workspace: --workspace SLUG")
		return 2
	}
	rid, err := backup.RestoreItem(ctx, st, files, archive, it)
	if err != nil {
		fmt.Fprintln(os.Stderr, "restore failed:", err)
		return 1
	}
	// Tell open browsers, and put the text back in the search index.
	var ws core.Workspace
	switch err := st.Get(ctx, &ws, store.Eq("slug", it.Workspace)); {
	case err == nil:
		eng := engine.New(st)
		if err := eng.AnnounceRestored(ctx, ws.ID, it.Kind, rid); err != nil {
			fmt.Fprintln(os.Stderr, "restored, but open browsers were not told:", err)
		}
		if err := eng.Reindex(ctx, ws.ID); err != nil {
			fmt.Fprintln(os.Stderr, "rebuilding search:", err)
		}
		shellAudit(ctx, st, shellAction{workspaceID: ws.ID, action: it.Kind + ".restored_from_backup", targetType: it.Kind, targetID: rid, data: map[string]string{"archive": ra.file}})
	case !errors.Is(err, store.ErrNotFound):
		fmt.Fprintln(os.Stderr, "restored, but open browsers and search were not told:", err)
	}
	fmt.Printf("brought back %s %s\n", it.Kind, it.Ref)
	return 0
}

// restoreAll loads the whole archive into an empty install and rebuilds
// each workspace's search index.
func restoreAll(ctx context.Context, st store.Store, files blob.Store, archive io.Reader, file string) int {
	m, err := backup.Restore(ctx, st, files, archive)
	if err != nil {
		fmt.Fprintln(os.Stderr, "restore failed:", err)
		return 1
	}
	var wss []core.Workspace
	if err := st.List(ctx, &wss, store.Q{}); err != nil {
		fmt.Fprintln(os.Stderr, "restored, but rebuilding search failed:", err)
		return 1
	}
	eng := engine.New(st)
	for _, ws := range wss {
		if err := eng.Reindex(ctx, ws.ID); err != nil {
			fmt.Fprintln(os.Stderr, "rebuilding search:", err)
		}
	}
	shellAudit(ctx, st, shellAction{action: "install.restored_from_backup", targetType: "backup", data: map[string]string{"archive": file}})
	fmt.Printf("restored the archive made %s: %d workspaces\n", time.UnixMilli(m.CreatedAt).UTC().Format(time.RFC3339), len(wss))
	return 0
}
