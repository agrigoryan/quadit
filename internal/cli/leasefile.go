// The file beside the login file where `quadit listen` (and each entry of
// `quadit run`) keeps its lease's id, one for each login (server and token)
// and scope (a project, or everything), held locked for as long as the
// listen runs, so one login has one companion in each scope.

package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// errAnotherListen refuses a second `quadit listen` on a login and scope
// whose lease file another one holds.
var errAnotherListen = errors.New("another quadit listen is running with this login, for the same project or for everything")

// leaseFile is the lease file of a login, open and locked.
type leaseFile struct{ f *os.File }

// openLeaseFile opens and locks the lease file of the login c signs in
// with, listening to project (as project= gave it; "" for everything), in
// dir, the folder of that login's file, or refuses when another listen
// holds it. Its name is a hash of the server, the token and the project,
// so logins given in QUADIT_URL and QUADIT_TOKEN have one each too;
// everything's is the one a listen from before projects kept.
func openLeaseFile(dir string, c *Client, project string) (*leaseFile, error) {
	login := c.URL + "\n" + c.Token
	if project != "" {
		login += "\n" + project
	}
	sum := sha256.Sum256([]byte(login))
	f, err := os.OpenFile(filepath.Join(dir, "listen-"+hex.EncodeToString(sum[:6])+".lease"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("the listener's lease file: %w", err)
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	return &leaseFile{f: f}, nil
}

// kept is the lease id kept in the file, or "" for none or one not of the
// form a lease id has.
func (l *leaseFile) kept() string {
	if _, err := l.f.Seek(0, io.SeekStart); err != nil {
		return ""
	}
	raw, err := io.ReadAll(l.f)
	if err != nil {
		return ""
	}
	if id := strings.TrimSpace(string(raw)); leaseForm.MatchString(id) {
		return id
	}
	return ""
}

// keep writes a lease id for the next start of listen. Best effort: a
// listen that cannot keep it takes a new one when it starts again, after
// the old one ran out.
func (l *leaseFile) keep(id string) {
	err := l.f.Truncate(0)
	if err == nil {
		_, err = l.f.WriteAt([]byte(id+"\n"), 0)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "the listener's lease could not be kept for the next start:", err)
	}
}

// close lets the file go, and with it the lock.
func (l *leaseFile) close() { l.f.Close() }
