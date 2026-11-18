// The backup and restore commands, run on the server's machine.

package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/backup"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// backupHelp is the help of quadit backup and quadit restore.
const backupHelp = `quadit backup [--out FILE]      write everything to one archive and verify it
quadit backup verify FILE       check an archive without restoring it
quadit restore FILE [--secret-key FILE | --without-secret-key]
                                load an archive into an empty install
quadit restore FILE --workspace SLUG --task KEY     bring back one task
quadit restore FILE --workspace SLUG --doc ID       bring back one page

The archive holds the database and the files together, and is the same on
SQLite and Postgres: it can be restored onto either. All take --data and
--db like "quadit serve".

The archive does not hold the install secret (secret.key in the data
directory, or QUADIT_SECRET), which seals sign-in codes, the vault,
integration tokens and the mail and storage passwords. Keep a copy of it
apart from the archives. A full restore checks that the secret it has
opens the archive's: give the original with --secret-key FILE, which then
becomes this install's; or, when it is lost, --without-secret-key restores
everything else, and those secrets must then be set again.
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
		// Named for now, in this folder, and never over a backup already there.
		made, err := backup.NewFile(".", time.Now())
		if err != nil {
			fmt.Fprintln(os.Stderr, "backup failed:", err)
			return 1
		}
		path = made.Name()
		_ = made.Close() // writeVerified opens it again to write
	}
	var m backup.Manifest
	size, err := writeVerified(path, func(w io.Writer) error {
		var werr error
		m, werr = backup.Write(ctx, st, files, sealer, version, w)
		return werr
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "backup failed:", err)
		return 1
	}
	fmt.Printf("%s written and verified (%d bytes)\n", path, size)
	if len(m.Missing) > 0 {
		fmt.Fprintf(os.Stderr, "warning: %d stored files the database names were not in file storage, so they are not in the archive: %s\n", len(m.Missing), strings.Join(m.Missing, ", "))
	}
	fmt.Println("The archive does not hold the install secret: keep a copy of it apart from your archives (see quadit restore --help).")
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
	// secretKey is the file of the install secret the archive was made
	// with, which the restored install then keeps.
	secretKey string
	// withoutSecretKey restores even though the archive's secret is lost.
	withoutSecretKey bool
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
	fs.StringVar(&ra.secretKey, "secret-key", "", "the install secret the archive was made with (its secret.key), which this install then keeps")
	fs.BoolVar(&ra.withoutSecretKey, "without-secret-key", false, "restore although the archive's install secret is lost; what it sealed must be set again")
	fs.Usage = func() { fmt.Fprint(os.Stderr, backupHelp) }
	var flags []string
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") {
			ra.file = args[i]
			continue
		}
		flags = append(flags, args[i])
		if !strings.Contains(args[i], "=") && strings.TrimLeft(args[i], "-") != "without-secret-key" && i+1 < len(args) {
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
	return restoreAll(ctx, st, files, sealer, f, ra)
}

// restoreItem brings one task or page back from the archive into a running
// install, telling open browsers, and then the search index.
func restoreItem(ctx context.Context, st store.Store, files blob.Store, archive io.Reader, ra restoreArgs) int {
	it := backup.Item{Workspace: ra.workspace, Kind: "task", Ref: ra.task}
	if ra.doc != "" {
		it.Kind, it.Ref = "doc", ra.doc
	}
	if it.Workspace == "" {
		fmt.Fprintln(os.Stderr, "say which workspace: --workspace SLUG")
		return 2
	}
	eng := engine.New(st, nil) // it only restores, announces and reindexes: no secret to seal
	rid, err := backup.RestoreItem(ctx, eng, files, archive, it)
	if err != nil {
		fmt.Fprintln(os.Stderr, "restore failed:", err)
		return 1
	}
	// Open browsers were told in the same write; put the text back in the
	// search index.
	var ws core.Workspace
	switch there, err := store.Find(ctx, st, &ws, store.Eq("slug", it.Workspace)); {
	case err != nil:
		fmt.Fprintln(os.Stderr, "restored, but search was not told:", err)
	case there:
		if err := eng.Reindex(ctx, ws.ID); err != nil {
			fmt.Fprintln(os.Stderr, "rebuilding search:", err)
		}
		shellAudit(ctx, st, shellAction{workspaceID: ws.ID, action: it.Kind + ".restored_from_backup", targetType: it.Kind, targetID: rid, data: map[string]string{"archive": ra.file}})
	}
	fmt.Printf("brought back %s %s\n", it.Kind, it.Ref)
	return 0
}

// restoreAll loads the whole archive into an empty install and rebuilds
// each workspace's search index. The archive's stored secrets must open
// with the install secret the install will run with: its own, or the one
// given with --secret-key, which is then written in its place.
func restoreAll(ctx context.Context, st store.Store, files blob.Store, own *auth.Sealer, archive io.ReadSeeker, ra restoreArgs) int {
	sealer, given, err := restoreSecret(own, ra)
	if err != nil {
		fmt.Fprintln(os.Stderr, "restore failed:", err)
		return 2
	}
	m, err := backup.Restore(ctx, st, files, sealer, archive)
	switch {
	case errors.Is(err, backup.ErrOtherSecret):
		fmt.Fprintf(os.Stderr, `restore failed: %v; nothing was restored.
Give the original install's secret: --secret-key /path/to/its/data/secret.key
(or set QUADIT_SECRET as it was set there). If it is lost for good,
--without-secret-key restores everything else; sign-in codes (two-step
sign-in), vault secrets, integration tokens and the mail and storage
passwords must then be set again.
`, err)
		return 1
	case errors.Is(err, backup.ErrNoKeyCheck):
		fmt.Fprintf(os.Stderr, `restore failed: %v, so the install secret cannot be checked; nothing was restored.
--without-secret-key restores it unchecked: sign-in codes (two-step sign-in),
vault secrets, integration tokens and the mail and storage passwords open
only if this install's secret is the one that sealed them (put the original
secret.key in the data directory, or set QUADIT_SECRET as it was set there);
otherwise they must be set again.
`, err)
		return 1
	case err != nil:
		fmt.Fprintln(os.Stderr, "restore failed:", err)
		return 1
	}
	if given != nil {
		if err := installSecret(ra.o.Data, given); err != nil {
			fmt.Fprintf(os.Stderr, "restored, but the install secret could not be put in place (%v): copy %s to %s before starting the server\n",
				err, ra.secretKey, filepath.Join(ra.o.Data, "secret.key"))
			return 1
		}
	}
	if ra.withoutSecretKey {
		fmt.Fprintln(os.Stderr, "restored without the archive's install secret: sign-in codes, vault secrets, integration tokens and the mail and storage passwords it holds cannot be opened, and must be set again")
	}
	var wss []core.Workspace
	if err := st.List(ctx, &wss, store.Q{}); err != nil {
		fmt.Fprintln(os.Stderr, "restored, but rebuilding search failed:", err)
		return 1
	}
	eng := engine.New(st, nil) // it only reindexes: no secret to seal
	for _, ws := range wss {
		if err := eng.Reindex(ctx, ws.ID); err != nil {
			fmt.Fprintln(os.Stderr, "rebuilding search:", err)
		}
	}
	shellAudit(ctx, st, shellAction{action: "install.restored_from_backup", targetType: "backup", data: map[string]string{"archive": ra.file}})
	fmt.Printf("restored the archive made %s: %d workspaces\n", time.UnixMilli(m.CreatedAt).UTC().Format(time.RFC3339), len(wss))
	return 0
}

// restoreSecret decides which install secret a full restore checks the
// archive against: the install's own, the one --secret-key gives (also
// returned, to be put in place once the restore is done), or none with
// --without-secret-key.
func restoreSecret(own *auth.Sealer, ra restoreArgs) (sealer *auth.Sealer, given []byte, err error) {
	switch {
	case ra.withoutSecretKey && ra.secretKey != "":
		return nil, nil, errors.New("give --secret-key or --without-secret-key, not both")
	case ra.withoutSecretKey:
		return nil, nil, nil
	case ra.secretKey == "":
		return own, nil, nil
	}
	given, err = os.ReadFile(ra.secretKey)
	if err != nil {
		return nil, nil, err
	}
	if len(given) < 16 {
		return nil, nil, fmt.Errorf("%s is not an install secret: it is shorter than 16 bytes", ra.secretKey)
	}
	if env := os.Getenv("QUADIT_SECRET"); env != "" && env != string(given) {
		return nil, nil, fmt.Errorf("QUADIT_SECRET is set, and is not the secret in %s: unset it, or set it to that secret and leave out --secret-key", ra.secretKey)
	}
	if sealer, err = auth.NewSealer(given); err != nil {
		return nil, nil, err
	}
	return sealer, given, nil
}

// installSecret makes secret the install's secret file in dataDir. The one
// there before, which the empty install made for itself and which sealed
// nothing the archive holds, is kept beside it.
func installSecret(dataDir string, secret []byte) error {
	path := filepath.Join(dataDir, "secret.key")
	if was, err := os.ReadFile(path); err == nil {
		if string(was) == string(secret) {
			return nil
		}
		if err := os.Rename(path, fmt.Sprintf("%s.before-restore-%d", path, time.Now().Unix())); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.WriteFile(path, secret, 0o600)
}
