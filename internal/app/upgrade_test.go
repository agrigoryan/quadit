package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/postgres"
	"github.com/agrigoryan/quadit/internal/store/sqlite"
)

// releasedVersion is the schema version of the last release, the one
// installs are upgraded from.
const releasedVersion = 13

// TestAnInstallOfTheLastReleaseIsUpgradedAndKeepsWorking takes a database
// as the last release left it, written row by row in that release's
// columns (a person with a password, a session from before sessions said
// how they signed in, an invitation from before invitations had a scope, a
// secret in the vault, a stored file and an upload half sent), through
// "quadit upgrade", and then: the server starts on it and starts again,
// the session and the invitation still work, the person signs in, the
// upload goes on to the file that was sent, a backup restores into a new
// install given the install secret, and "quadit upgrade --undo" puts the
// database back as it was, with the upload's parts where the last release
// looks for them.
func TestAnInstallOfTheLastReleaseIsUpgradedAndKeepsWorking(t *testing.T) {
	t.Setenv("QUADIT_SECRET", "")
	t.Setenv("QUADIT_DATA", "")
	t.Setenv("QUADIT_DB", "")
	t.Run("sqlite", func(t *testing.T) {
		dir := t.TempDir()
		upgradeAndUse(t, dir, filepath.Join(dir, "quadit.sqlite"))
	})
	t.Run("postgres", func(t *testing.T) {
		upgradeAndUse(t, t.TempDir(), postgresDatabase(t))
	})
}

// postgresDatabase makes an empty database of its own on the test server,
// as an upgrade copies and renames whole databases, and gives its URL. It
// skips the test when QUADIT_TEST_POSTGRES is not set.
func postgresDatabase(t *testing.T) string {
	t.Helper()
	base := os.Getenv("QUADIT_TEST_POSTGRES")
	if base == "" {
		t.Skip("QUADIT_TEST_POSTGRES is not set")
	}
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("quadit_release_%d", time.Now().UnixNano())
	if _, err := admin.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Fatal(err)
	}
	// Cleanups run last first: the databases are dropped, then the
	// connection that drops them is closed.
	t.Cleanup(func() { admin.Close() })
	t.Cleanup(func() {
		// The upgrade's copy and the database --undo moves aside go too.
		names, err := databasesNamed(admin, name)
		if err != nil {
			t.Logf("databases of %s are left behind: %v", name, err)
		}
		for _, n := range names {
			if _, err := admin.Exec(`DROP DATABASE IF EXISTS ` + n + ` WITH (FORCE)`); err != nil {
				t.Logf("database %s is left behind: %v", n, err)
			}
		}
	})
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}

// databasesNamed lists the databases whose names start with prefix.
func databasesNamed(admin *sql.DB, prefix string) ([]string, error) {
	rows, err := admin.Query(`SELECT datname FROM pg_database WHERE datname LIKE $1`, prefix+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return names, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

// released is what the test writes as the last release did, and checks
// after the upgrade.
type released struct {
	ws, owner, ready string
	// Uploads in parts, each with its first part kept: one the newer
	// version finishes, and one it goes on with but does not finish.
	upload, unfinished string
	session, invite    string // the raw tokens
	secret             []byte // the install secret
}

const (
	ownerEmail    = "owner@example.com"
	ownerPassword = "a long password"
)

// writeReleased makes the database at db (a SQLite path or a Postgres
// URL) as the last release made it, with its rows and files, in the data
// directory dir.
func writeReleased(t *testing.T, dir, db string) released {
	t.Helper()
	ctx := context.Background()
	isPostgres := strings.HasPrefix(db, "postgres")
	var raw *sqlOpened
	if isPostgres {
		old, err := postgres.OpenAt(ctx, db, releasedVersion)
		if err != nil {
			t.Fatal(err)
		}
		old.Close()
		raw = openRaw(t, "pgx", db, true)
	} else {
		old, err := sqlite.OpenAt(ctx, db, releasedVersion)
		if err != nil {
			t.Fatal(err)
		}
		old.Close()
		raw = openRaw(t, "sqlite", "file:"+db, false)
	}
	defer raw.db.Close()

	r := released{ws: id.New(), owner: id.New(), upload: id.New(), unfinished: id.New(), ready: id.New(), session: auth.Random(32), invite: auth.Random(32),
		secret: []byte(auth.Random(32))}
	if err := os.WriteFile(filepath.Join(dir, "secret.key"), r.secret, 0o600); err != nil {
		t.Fatal(err)
	}
	sealer, err := auth.NewSealer(r.secret)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealer.Seal("s3cr3t")
	if err != nil {
		t.Fatal(err)
	}
	hash, err := auth.HashPassword(ownerPassword)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	later := now + int64(30*24*time.Hour/time.Millisecond)
	raw.exec(t, `INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES (?, 'games', 'Games', ?, ?)`, r.ws, now, now)
	raw.exec(t, `INSERT INTO users (id, kind, name, email, password_hash, is_admin, created_at, updated_at) VALUES (?, 'person', 'Owner', ?, ?, ?, ?, ?)`,
		r.owner, ownerEmail, hash, true, now, now)
	raw.exec(t, `INSERT INTO members (workspace_id, user_id, role, handle, kind, name, created_at, updated_seq) VALUES (?, ?, 'owner', 'owner', 'person', 'Owner', ?, 1)`,
		r.ws, r.owner, now)
	raw.exec(t, `INSERT INTO sessions (id, token_hash, user_id, stage, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, 'full', ?, ?, ?)`,
		id.New(), auth.Hash(r.session), r.owner, now, now, later)
	raw.exec(t, `INSERT INTO invites (id, workspace_id, email, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, 'new@example.com', 'member', ?, ?, ?, ?)`,
		id.New(), r.ws, auth.Hash(r.invite), r.owner, now, later)
	raw.exec(t, `INSERT INTO secrets (id, workspace_id, name, value, created_by, created_at, updated_at, updated_seq) VALUES (?, ?, 'DEPLOY_TOKEN', ?, ?, ?, ?, 1)`,
		id.New(), r.ws, sealed, r.owner, now, now)

	// A stored file, and an upload in parts with its first part kept as the
	// last release kept one: under a key made from its offset alone.
	put := func(key, body string) {
		path := filepath.Join(dir, "files", filepath.FromSlash(key))
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	readyKey := r.ws + "/" + r.ready
	put(readyKey, "the notes")
	raw.exec(t, `INSERT INTO files (id, workspace_id, name, content_type, size, received, sha256, storage_key, state, uploaded_by, created_at) VALUES (?, ?, 'notes.txt', 'text/plain', 9, 9, ?, ?, 'ready', ?, ?)`,
		r.ready, r.ws, sumOf("the notes"), readyKey, r.owner, now)
	for fid, size := range map[string]int{r.upload: 10, r.unfinished: 15} {
		uploadKey := r.ws + "/" + fid
		put(fmt.Sprintf("%s.parts/%020d", uploadKey, 0), "hello")
		raw.exec(t, `INSERT INTO files (id, workspace_id, name, content_type, size, received, storage_key, state, uploaded_by, created_at) VALUES (?, ?, 'clip.bin', 'application/octet-stream', ?, 5, ?, 'uploading', ?, ?)`,
			fid, r.ws, size, uploadKey, r.owner, now)
	}
	return r
}

// sqlOpened is a database opened without the store, to write rows in the
// columns of an older schema.
type sqlOpened struct {
	db       *sql.DB
	numbered bool // Postgres numbers its placeholders: $1, $2, …
}

func openRaw(t *testing.T, driver, dsn string, numbered bool) *sqlOpened {
	t.Helper()
	db, err := sql.Open(driver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	return &sqlOpened{db: db, numbered: numbered}
}

// exec runs one statement written with ? placeholders.
func (o *sqlOpened) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if o.numbered {
		for i := 1; strings.Contains(query, "?"); i++ {
			query = strings.Replace(query, "?", fmt.Sprintf("$%d", i), 1)
		}
	}
	if _, err := o.db.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func sumOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// running is a server started on an install, as quadit serve starts it.
type running struct {
	url  string
	stop func()
}

// serve starts a server on the install and gives where it answers; stop
// ends it and closes the database.
func serve(t *testing.T, o Options) running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	st, sealer, err := o.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	files, err := blob.NewDisk(filepath.Join(o.Data, "files"))
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewUnstartedServer(nil)
	base := "http://" + hs.Listener.Addr().String()
	srv := server.New(ctx, server.Config{DataDir: o.Data, BaseURL: base, Version: "test"}, st, files, sealer)
	hs.Config.Handler = srv.Handler()
	hs.Start()
	ran := make(chan struct{})
	go func() {
		defer close(ran)
		srv.Run(ctx)
	}()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		<-ran
		hs.Close()
		st.Close()
	}
	t.Cleanup(stop)
	return running{url: base, stop: stop}
}

// call sends a request as the web app's own page would, with the session
// in jar, and checks the answer's status; it gives the answer's body.
func call(t *testing.T, hc *http.Client, method, u string, body io.Reader, want int) string {
	t.Helper()
	req, err := http.NewRequest(method, u, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		t.Fatalf("%s %s: %d, want %d: %s", method, u, resp.StatusCode, want, raw)
	}
	return string(raw)
}

// withSession is a client whose jar holds the session token for the server
// at base.
func withSession(t *testing.T, base, token string) *http.Client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	u, _ := url.Parse(base)
	if token != "" {
		jar.SetCookies(u, []*http.Cookie{{Name: "quadit_session", Value: token, Path: "/"}})
	}
	return &http.Client{Jar: jar}
}

// upgradeAndUse goes through the test's steps on an install with its data
// in dir and its database at db: a SQLite path or a Postgres URL.
func upgradeAndUse(t *testing.T, dir, db string) {
	ctx := context.Background()
	r := writeReleased(t, dir, db)
	o := Options{Data: dir, DB: db}
	isPostgres := strings.HasPrefix(db, "postgres")

	var code int
	stdoutOf(t, func() { code = Upgrade([]string{"--data", dir, "--db", db}, "test") })
	if code != 0 {
		t.Fatalf("quadit upgrade: exit %d", code)
	}

	// The server starts on the upgraded database, and starts again.
	for start := range 2 {
		srv := serve(t, o)
		w := srv.url + "/api/v1/w/games"
		old := withSession(t, srv.url, r.session)
		if out := call(t, old, "GET", srv.url+"/api/v1/auth/me", nil, http.StatusOK); !strings.Contains(out, ownerEmail) {
			t.Fatalf("start %d: the session from before the upgrade: %s", start, out)
		}
		if start == 0 {
			// The upload goes on from the part the last release kept.
			out := call(t, old, "PATCH", w+"/files/"+r.upload+"?offset=5", strings.NewReader("world"), http.StatusOK)
			var f core.File
			if err := json.Unmarshal([]byte(out), &f); err != nil || f.State != core.FileReady || f.SHA256 != sumOf("helloworld") {
				t.Fatalf("the upload after the upgrade ended as %s, want the sum of helloworld", out)
			}
			out = call(t, old, "PATCH", w+"/files/"+r.unfinished+"?offset=5", strings.NewReader("world"), http.StatusOK)
			if err := json.Unmarshal([]byte(out), &f); err != nil || f.State != core.FileUploading || f.Received != 10 {
				t.Fatalf("the upload gone on with after the upgrade is %s, want 10 bytes received", out)
			}
			// The invitation from before invitations had a scope is taken.
			call(t, withSession(t, srv.url, ""), "POST", srv.url+"/api/v1/auth/invite/"+r.invite,
				strings.NewReader(`{"name":"New","email":"new@example.com","password":"another long password"}`), http.StatusOK)
		}
		signedIn := withSession(t, srv.url, "")
		call(t, signedIn, "POST", srv.url+"/api/v1/auth/login", strings.NewReader(`{"email":"`+ownerEmail+`","password":"`+ownerPassword+`"}`), http.StatusOK)
		if out := call(t, signedIn, "GET", w+"/files/"+r.upload, nil, http.StatusOK); !strings.Contains(out, `"state":"ready"`) {
			t.Fatalf("start %d: the finished upload: %s", start, out)
		}
		if out := call(t, signedIn, "GET", w+"/list/members", nil, http.StatusOK); !strings.Contains(out, "new@example.com") && !strings.Contains(out, `"New"`) {
			t.Fatalf("start %d: the invited person is not a member: %s", start, out)
		}
		srv.stop()
	}

	// A backup restores into a new install that is given the install secret.
	archive := filepath.Join(t.TempDir(), "quadit.tar.gz")
	stdoutOf(t, func() { code = Backup([]string{"--data", dir, "--db", db, "--out", archive}, "test") })
	if code != 0 {
		t.Fatalf("backup: exit %d", code)
	}
	fresh := t.TempDir()
	stdoutOf(t, func() {
		code = Restore([]string{archive, "--data", fresh, "--secret-key", filepath.Join(dir, "secret.key")}, "test")
	})
	if code != 0 {
		t.Fatalf("restore: exit %d", code)
	}
	restored := serve(t, Options{Data: fresh})
	signedIn := withSession(t, restored.url, "")
	call(t, signedIn, "POST", restored.url+"/api/v1/auth/login", strings.NewReader(`{"email":"`+ownerEmail+`","password":"`+ownerPassword+`"}`), http.StatusOK)
	for fid, want := range map[string]string{r.ready: "the notes", r.upload: "helloworld"} {
		if got := call(t, signedIn, "GET", restored.url+"/f/"+fid+"/file", nil, http.StatusOK); got != want {
			t.Fatalf("the restored file %s holds %q, want %q", fid, got, want)
		}
	}
	// The archive holds no part of an upload still arriving: it starts again.
	if out := call(t, signedIn, "GET", restored.url+"/api/v1/w/games/files/"+r.unfinished, nil, http.StatusOK); strings.Contains(out, `"received"`) {
		t.Fatalf("the restored upload still arriving: %s, want it at 0", out)
	}
	restored.stop()
	st, sealer, err := (&Options{Data: fresh}).Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var sec core.Secret
	if err := st.In(r.ws).Get(ctx, &sec, store.Eq("name", "DEPLOY_TOKEN")); err != nil {
		t.Fatal(err)
	}
	if plain, err := sealer.Open(sec.Value); err != nil || plain != "s3cr3t" {
		t.Fatalf("the restored vault's secret opens as %q, %v", plain, err)
	}
	st.Close()

	// quadit upgrade --undo puts the database back as the last release had it.
	stdoutOf(t, func() { code = Upgrade([]string{"--undo", "--data", dir, "--db", db}, "test") })
	if code != 0 {
		t.Fatalf("quadit upgrade --undo: exit %d", code)
	}
	var back *sqlOpened
	if isPostgres {
		back = openRaw(t, "pgx", db, true)
	} else {
		back = openRaw(t, "sqlite", "file:"+db, false)
	}
	defer back.db.Close()
	var version int
	if err := back.db.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil || version != releasedVersion {
		t.Fatalf("after going back the schema is at %d (%v), want %d", version, err, releasedVersion)
	}
	for _, fid := range []string{r.upload, r.unfinished} {
		var state string
		var received int64
		if err := back.db.QueryRowContext(ctx, `SELECT state, received FROM files WHERE id = `+placeholder(isPostgres), fid).Scan(&state, &received); err != nil {
			t.Fatal(err)
		}
		if state != core.FileUploading || received != 5 {
			t.Fatalf("after going back the upload %s is %s with %d bytes, want uploading with 5, as before the upgrade", fid, state, received)
		}
		// The last release goes on from the parts it finds, all of them: they
		// must be the 5 bytes it counted, and nothing the newer version kept.
		if got := releasedParts(t, dir, r.ws+"/"+fid); got != "hello" {
			t.Fatalf("after going back the last release would go on with the upload %s from %q, want the %q it had", fid, got, "hello")
		}
	}
}

// releasedParts is what the last release puts together, to go on with an
// upload in parts: every part in file storage under the upload's key and
// ".parts/", in the order of their names.
func releasedParts(t *testing.T, dir, key string) string {
	t.Helper()
	folder := filepath.Join(dir, "files", filepath.FromSlash(key)+".parts")
	entries, err := os.ReadDir(folder)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var joined strings.Builder
	for _, e := range entries { // ReadDir gives them in the order of their names
		raw, err := os.ReadFile(filepath.Join(folder, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		joined.Write(raw)
	}
	return joined.String()
}

// placeholder is the first placeholder of a statement on the database.
func placeholder(isPostgres bool) string {
	if isPostgres {
		return "$1"
	}
	return "?"
}
