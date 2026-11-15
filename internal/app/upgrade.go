// The upgrade command: bringing the database up to this binary's version,
// and undoing that.

package app

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/agrigoryan/quadit/internal/store/postgres"
	"github.com/agrigoryan/quadit/internal/store/sqlite"
)

// Upgrade brings the database up to this binary's version, leaving a copy
// of it as it was; with --undo it puts that copy back. Starting the server
// does the first by itself; the command is for doing it as a step of its own.
func Upgrade(args []string, version string) int {
	var o Options
	fs := flag.NewFlagSet("upgrade", flag.ExitOnError)
	o.registerFlags(fs)
	undo := fs.Bool("undo", false, "put back the copy made before the last upgrade; then run the older binary")
	fs.Parse(args)
	ctx := context.Background()
	isPostgres := strings.HasPrefix(o.DB, "postgres://") || strings.HasPrefix(o.DB, "postgresql://")
	path := o.DB
	if !isPostgres && path == "" {
		path = filepath.Join(o.Data, "quadit.sqlite")
	}
	if *undo {
		// Not under a running server: it would go on writing to the
		// database that is being put aside.
		release, lerr := lockData(o.Data)
		if lerr != nil {
			fmt.Fprintln(os.Stderr, "could not go back:", lerr)
			return 1
		}
		defer release()
		var from, aside string
		var err error
		if isPostgres {
			from, aside, err = postgres.UndoUpgrade(ctx, o.DB)
		} else {
			from, aside, err = sqlite.UndoUpgrade(ctx, path)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "could not go back:", err)
			return 1
		}
		fmt.Printf("the database is as it was before the upgrade (from %s).\nThe upgraded one is kept as %s.\nNow run the older binary.\n", from, aside)
		return 0
	}
	st, _, err := o.Open(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "upgrade failed; nothing was changed:", err)
		return 1
	}
	defer st.Close()
	v, err := st.(interface {
		SchemaVersion(context.Context) (int, error)
	}).SchemaVersion(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "the database was upgraded, but its schema version could not be read:", err)
		return 1
	}
	fmt.Printf("the database is at schema version %d, which is what quadit %s uses.\nTo go back: stop the server, run \"quadit upgrade --undo\", and start the older binary.\n", v, version)
	return 0
}
