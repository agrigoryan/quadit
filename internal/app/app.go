// Package app wires the server together and holds the commands that run
// on the server's machine, next to its data.
//
// How the package is laid out:
//
//	app.go       Options (where the data lives), serve, and the admin commands
//	backup.go    backup and restore
//	upgrade.go   upgrade, and undoing one
//	lock.go      one server per data directory
//	web.go       the built-in web app (built with -tags web)
package app

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/server"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/store/postgres"
	"github.com/agrigoryan/quadit/internal/store/sqlite"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

// Commands are extra server-side commands added by other files.
var Commands = map[string]func(args []string, version string) int{}

// Options say where the data lives. Each can come from a flag or from the
// environment, so scripted installs need no flags.
type Options struct {
	Data    string // the data directory: database, files, the install secret
	DB      string // a SQLite file path or a postgres:// URL; empty: SQLite in Data
	Listen  string // the address the server listens on
	BaseURL string // the address people reach the server at
}

// envOr is the environment variable name, or def when it is empty.
func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// registerFlags adds --data and --db, which every command here takes.
func (o *Options) registerFlags(fs *flag.FlagSet) {
	fs.StringVar(&o.Data, "data", envOr("QUADIT_DATA", "./data"), "directory for the database, files and the install secret (QUADIT_DATA)")
	fs.StringVar(&o.DB, "db", envOr("QUADIT_DB", ""), "database: a SQLite file path or a postgres:// URL; default is quadit.sqlite in the data directory (QUADIT_DB)")
}

// Open opens the database and everything beside it.
func (o *Options) Open(ctx context.Context) (store.Store, *auth.Sealer, error) {
	if err := os.MkdirAll(o.Data, 0o750); err != nil {
		return nil, nil, err
	}
	var st store.Store
	var err error
	if strings.HasPrefix(o.DB, "postgres://") || strings.HasPrefix(o.DB, "postgresql://") {
		st, err = postgres.Open(ctx, o.DB)
	} else {
		path := o.DB
		if path == "" {
			path = filepath.Join(o.Data, "quadit.sqlite")
		}
		st, err = sqlite.Open(ctx, path)
	}
	if err != nil {
		return nil, nil, err
	}
	secret, err := o.secret()
	if err != nil {
		st.Close()
		return nil, nil, err
	}
	sealer, err := auth.NewSealer(secret)
	if err != nil {
		st.Close()
		return nil, nil, err
	}
	return st, sealer, nil
}

// secret returns the install's secret: from QUADIT_SECRET, or from a file
// in the data directory that is made on first run. It encrypts the tokens
// and passwords of outside services kept in the database.
func (o *Options) secret() ([]byte, error) {
	if v := os.Getenv("QUADIT_SECRET"); v != "" {
		if len(v) < 16 {
			return nil, errors.New("QUADIT_SECRET must be at least 16 characters")
		}
		return []byte(v), nil
	}
	path := filepath.Join(o.Data, "secret.key")
	raw, err := os.ReadFile(path)
	switch {
	case err == nil && len(raw) >= 16:
		return raw, nil
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		// A secret that is there but cannot be read is not replaced: what
		// it sealed would be lost.
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	raw = []byte(auth.Random(32))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	return raw, nil
}

// Serve runs the server until it is told to stop.
func Serve(args []string, version string) int {
	run := &serveRun{version: version}
	run.parse(args)
	https := run.flags.tlsDomain != "" || run.flags.tlsCert != ""
	if (run.flags.tlsCert == "") != (run.flags.tlsKey == "") {
		fmt.Fprintln(os.Stderr, "--tls-cert and --tls-key go together")
		return 1
	}
	if https && run.o.Listen == ":4780" {
		run.o.Listen = ":443" // the usual place for HTTPS, unless told otherwise
	}
	run.https = https
	run.log = run.newLogger()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// One server per data directory: a second one, or an upgrade being
	// undone, must not run beside it. Several servers may share a Postgres
	// database; each has its own directory or none to guard.
	if !strings.HasPrefix(run.o.DB, "postgres") {
		release, err := lockData(run.o.Data)
		if err != nil {
			run.log.Error("cannot start", "err", err)
			return 1
		}
		defer release()
	}
	st, sealer, err := run.o.Open(ctx)
	if err != nil {
		run.log.Error("cannot start", "err", err)
		return 1
	}
	defer st.Close()
	return run.serve(ctx, st, sealer)
}

// serveFlags are what quadit serve is told beside the Options: logging,
// and how it serves HTTPS.
type serveFlags struct {
	jsonLog         bool
	tlsCert, tlsKey string
	tlsDomain       string // with Let's Encrypt (or another ACME authority)
	acmeDir, acmeCA string
	acmeHTTP        string // where the plain-HTTP side of ACME listens
	localListen     string // with HTTPS on: the server's own plain address
}

// serveRun is one run of quadit serve: what it was told, and the server
// once it is made.
type serveRun struct {
	version string
	o       Options
	flags   serveFlags
	https   bool
	log     *slog.Logger
	srv     *server.Server
}

// The servers' limits: how long a request's headers may take to arrive,
// how long the server has to finish what it is doing when told to stop,
// and how long a request to an ACME authority may take.
const (
	readHeaderTimeout = 10 * time.Second
	shutdownTimeout   = 5 * time.Second
	acmeTimeout       = 30 * time.Second
)

// parse reads quadit serve's flags, each of which can also come from the
// environment.
func (run *serveRun) parse(args []string) {
	o, f := &run.o, &run.flags
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	o.registerFlags(fs)
	fs.StringVar(&o.Listen, "listen", envOr("QUADIT_LISTEN", ":4780"), "address to listen on (QUADIT_LISTEN)")
	fs.StringVar(&o.BaseURL, "url", envOr("QUADIT_BASE_URL", ""), "the address people use to reach the server, e.g. https://quadit.example.com (QUADIT_BASE_URL)")
	fs.BoolVar(&f.jsonLog, "log-json", envOr("QUADIT_LOG", "") == "json", "write logs as JSON (QUADIT_LOG=json)")
	fs.StringVar(&f.tlsCert, "tls-cert", envOr("QUADIT_TLS_CERT", ""), "serve HTTPS with this certificate file (QUADIT_TLS_CERT), with --tls-key")
	fs.StringVar(&f.tlsKey, "tls-key", envOr("QUADIT_TLS_KEY", ""), "the certificate's private key file (QUADIT_TLS_KEY)")
	fs.StringVar(&f.tlsDomain, "tls-domain", envOr("QUADIT_TLS_DOMAIN", ""), "serve HTTPS for this name with a free certificate from Let's Encrypt, got and renewed by itself; needs ports 443 and 80 reachable (QUADIT_TLS_DOMAIN)")
	fs.StringVar(&f.acmeDir, "acme-directory", envOr("QUADIT_ACME_DIRECTORY", ""), "with --tls-domain: another certificate authority that speaks ACME (a company's own, or a test one); default Let's Encrypt (QUADIT_ACME_DIRECTORY)")
	fs.StringVar(&f.acmeCA, "acme-ca", envOr("QUADIT_ACME_CA", ""), "a PEM file to trust when talking to that authority, when its own certificate is not publicly trusted (QUADIT_ACME_CA)")
	fs.StringVar(&f.acmeHTTP, "acme-http-listen", envOr("QUADIT_ACME_HTTP_LISTEN", ":80"), "with --tls-domain: where the plain-HTTP side listens, which answers the authority's checks and sends everyone else to HTTPS (QUADIT_ACME_HTTP_LISTEN)")
	fs.StringVar(&f.localListen, "local-listen", envOr("QUADIT_LOCAL_LISTEN", "127.0.0.1:4781"), "with HTTPS on: a plain address on this machine only, for the server's own use (QUADIT_LOCAL_LISTEN)")
	fs.Parse(args)
}

// newLogger makes the server's logger, in text or JSON as asked, and makes
// it the default one.
func (run *serveRun) newLogger() *slog.Logger {
	var handler slog.Handler = slog.NewTextHandler(os.Stderr, nil)
	if run.flags.jsonLog {
		handler = slog.NewJSONHandler(os.Stderr, nil)
	}
	log := slog.New(handler)
	slog.SetDefault(log)
	return log
}

// serve makes the server on an open database, listens until ctx is done or
// a listener fails, and then stops it.
func (run *serveRun) serve(ctx context.Context, st store.Store, sealer *auth.Sealer) int {
	o := &run.o
	o.BaseURL = strings.TrimRight(run.baseURL(), "/")
	files, err := blob.NewDisk(filepath.Join(o.Data, "files"))
	if err != nil {
		run.log.Error("file storage", "err", err)
		return 1
	}
	run.srv = server.New(server.Config{DataDir: o.Data, BaseURL: o.BaseURL, LocalURL: "http://" + run.localAddress(), Version: run.version, Log: run.log}, st, files, sealer)
	if web := WebHandler(); web != nil {
		run.srv.SetWeb(web)
	}
	go run.srv.Run(ctx)

	hs := &http.Server{Addr: o.Listen, Handler: run.srv.Handler(), ReadHeaderTimeout: readHeaderTimeout}
	errc := make(chan error, 3)
	if err := run.listen(hs, errc); err != nil {
		run.log.Error("cannot start", "err", err)
		return 1
	}
	if run.https {
		// A plain door for the server itself (pictures of pages, health
		// checks on the machine); nothing outside can reach it.
		ls := &http.Server{Addr: run.flags.localListen, Handler: run.srv.Handler(), ReadHeaderTimeout: readHeaderTimeout}
		go func() { errc <- ls.ListenAndServe() }()
		defer func() {
			if err := ls.Close(); err != nil {
				run.log.Warn("the local listener did not close", "err", err)
			}
		}()
	}
	run.log.Info("quadit is running", "version", run.version, "listen", o.Listen, "https", run.https, "url", o.BaseURL, "database", st.Dialect(), "files", files.Kind())
	select {
	case err := <-errc:
		run.log.Error("server stopped", "err", err)
		return 1
	case <-ctx.Done():
	}
	run.log.Info("shutting down")
	run.srv.Stop()
	// ctx is done by now: the time to finish is counted on one that is not.
	shut, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()
	if err := hs.Shutdown(shut); err != nil {
		run.log.Warn("requests were cut off", "err", err)
	}
	return 0
}

// baseURL is the address people reach the server at: the one it was
// given, or one made from where it listens.
func (run *serveRun) baseURL() string {
	if run.o.BaseURL != "" {
		return run.o.BaseURL
	}
	host := run.o.Listen
	if strings.HasPrefix(host, ":") {
		host = "localhost" + host
	}
	switch {
	case run.flags.tlsDomain != "":
		return "https://" + run.flags.tlsDomain
	case run.https:
		return "https://" + host
	}
	return "http://" + host
}

// localAddress is where the server reaches itself without TLS, on this
// machine only.
func (run *serveRun) localAddress() string {
	if run.https {
		return run.flags.localListen
	}
	if strings.HasPrefix(run.o.Listen, ":") {
		return "127.0.0.1" + run.o.Listen
	}
	return run.o.Listen
}

// listen starts the listeners for how the server serves: plain HTTP, HTTPS
// with a certificate given, or HTTPS with certificates from an ACME
// authority. Each sends its end to errc.
func (run *serveRun) listen(hs *http.Server, errc chan<- error) error {
	switch {
	case run.flags.tlsDomain != "":
		m, err := run.certManager()
		if err != nil {
			return err
		}
		hs.TLSConfig = m.TLSConfig()
		go func() { errc <- hs.ListenAndServeTLS("", "") }()
		go func() {
			errc <- (&http.Server{Addr: run.flags.acmeHTTP, Handler: m.HTTPHandler(nil), ReadHeaderTimeout: readHeaderTimeout}).ListenAndServe()
		}()
	case run.https:
		hs.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		go func() { errc <- hs.ListenAndServeTLS(run.flags.tlsCert, run.flags.tlsKey) }()
	default:
		go func() { errc <- hs.ListenAndServe() }()
	}
	return nil
}

// certManager gets certificates from Let's Encrypt, or the authority named
// with --acme-directory, keeps them in the data directory and renews them as
// they age. Port 80 answers its checks and sends everyone else to HTTPS.
func (run *serveRun) certManager() (*autocert.Manager, error) {
	f := run.flags
	m := &autocert.Manager{Prompt: autocert.AcceptTOS, HostPolicy: autocert.HostWhitelist(strings.Split(f.tlsDomain, ",")...),
		Cache: autocert.DirCache(filepath.Join(run.o.Data, "certs"))}
	if f.acmeDir == "" {
		return m, nil
	}
	client := &acme.Client{DirectoryURL: f.acmeDir}
	if f.acmeCA != "" {
		pem, err := os.ReadFile(f.acmeCA)
		if err != nil {
			return nil, fmt.Errorf("--acme-ca: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("--acme-ca: %s holds no certificate", f.acmeCA)
		}
		client.HTTPClient = &http.Client{Timeout: acmeTimeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	}
	m.Client = client
	return m, nil
}

// OpenFiles returns the file store the install is set to use: what the
// "files" setting says, read from the environment or the database, with the
// local disk as the place old files may still be.
func OpenFiles(ctx context.Context, st store.Store, sealer *auth.Sealer, dataDir string) (blob.Store, error) {
	disk, err := blob.NewDisk(filepath.Join(dataDir, "files"))
	if err != nil {
		return nil, err
	}
	cfg, err := filesConfig(ctx, st, sealer)
	if err != nil {
		return nil, err
	}
	if cfg.Kind == "" || cfg.Kind == "disk" {
		return disk, nil
	}
	cloud, err := blob.Open(ctx, cfg, dataDir)
	if err != nil {
		return nil, err
	}
	return blob.Layered{Primary: cloud, Old: disk}, nil
}

// filesConfig is the "files" setting: from QUADIT_SETTING_FILES, or from
// the database with its secrets unsealed. No setting is the zero Config,
// which is the local disk.
func filesConfig(ctx context.Context, st store.Store, sealer *auth.Sealer) (blob.Config, error) {
	var cfg blob.Config
	if v := os.Getenv("QUADIT_SETTING_FILES"); v != "" {
		if err := json.Unmarshal([]byte(v), &cfg); err != nil {
			return cfg, fmt.Errorf("QUADIT_SETTING_FILES: %w", err)
		}
		return cfg, nil
	}
	var set core.Setting
	err := st.Get(ctx, &set, store.Eq("name", "files"))
	if errors.Is(err, store.ErrNotFound) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(set.Value, &cfg); err != nil {
		return cfg, fmt.Errorf("the files setting: %w", err)
	}
	for _, f := range []*string{&cfg.SecretKey, &cfg.Credentials, &cfg.AccountKey} {
		if plain, err := sealer.Open(*f); err == nil {
			*f = plain // a value that does not open was stored plain
		}
	}
	return cfg, nil
}

// WebHandler returns the handler that serves the built-in web app, or nil
// when the binary was built without it.
var WebHandler = func() http.Handler { return nil }

// adminHelp is the help of quadit admin.
const adminHelp = `quadit admin: commands run on the server's machine

  quadit admin setup --name N --email E --password P --workspace W
        make the first person and workspace without the web page
  quadit admin reset-password EMAIL
        set a new random password and print it (for installs with no mail)
  quadit admin token [--secrets] WORKSPACE @HANDLE [NAME]
        issue an API token for a member and print it once
  quadit admin make-admin EMAIL
        let a person run the install

all take --data and --db like "quadit serve".
`

// Admin runs a command against the database directly.
func Admin(args []string, _ string) int {
	if len(args) == 0 {
		fmt.Print(adminHelp)
		return 0
	}
	run := &adminRun{}
	fs := flag.NewFlagSet("admin "+args[0], flag.ExitOnError)
	run.o.registerFlags(fs)
	fs.StringVar(&run.name, "name", "", "the person's name")
	fs.StringVar(&run.email, "email", "", "the person's email")
	fs.StringVar(&run.password, "password", "", "the person's password")
	fs.StringVar(&run.workspace, "workspace", "", "the workspace's name")
	fs.BoolVar(&run.forSecrets, "secrets", false, "token: for a companion, which may receive secrets marked for an environment")
	var flags []string
	run.pos, flags = splitAdminArgs(args[1:])
	fs.Parse(flags)
	run.ctx = context.Background()
	st, _, err := run.o.Open(run.ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer st.Close()
	run.st = st
	command, ok := adminCommands[args[0]]
	if !ok {
		fmt.Print(adminHelp)
		return 2
	}
	if err := command(run); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// adminRun is one run of quadit admin: the database, and what the command
// was given. Being one run, it holds the run's context.
type adminRun struct {
	ctx context.Context
	o   Options
	st  store.Store
	pos []string // the arguments that are not flags

	name, email, password, workspace string
	forSecrets                       bool
}

// adminCommands are the subcommands of quadit admin, by name.
var adminCommands = map[string]func(run *adminRun) error{
	"setup":          (*adminRun).setup,
	"reset-password": (*adminRun).resetPassword,
	"make-admin":     (*adminRun).makeAdmin,
	"token":          (*adminRun).token,
}

// splitAdminArgs parts the flags from the positional arguments: flags may
// come before or after them.
func splitAdminArgs(args []string) (pos, flags []string) {
	for i := 0; i < len(args); i++ {
		if !strings.HasPrefix(args[i], "-") {
			pos = append(pos, args[i])
			continue
		}
		flags = append(flags, args[i])
		if strings.TrimLeft(args[i], "-") == "secrets" {
			continue // a switch: it takes no value
		}
		if !strings.Contains(args[i], "=") && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return pos, flags
}

// person finds the person with an email address.
func (run *adminRun) person(addr string) (core.User, error) {
	var u core.User
	err := run.st.Get(run.ctx, &u, store.Eq("email", strings.ToLower(addr)), store.Live)
	if errors.Is(err, store.ErrNotFound) {
		return u, fmt.Errorf("no person with the email %s", addr)
	}
	return u, err
}

// setup makes the first person and workspace.
func (run *adminRun) setup() error {
	ctx, st := run.ctx, run.st
	if err := auth.CheckPasswordRules(run.password); err != nil {
		return err
	}
	n, err := st.Count(ctx, "users", store.Eq("kind", core.KindPerson))
	if err != nil {
		return err
	}
	if n > 0 {
		return errors.New("this install is already set up")
	}
	eng := engine.New(st)
	slug := strings.ToLower(strings.Join(strings.Fields(run.workspace), "-"))
	ws, owner, err := eng.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: run.name, OwnerEmail: run.email, WorkspaceSlug: slug, WorkspaceName: run.workspace})
	if err != nil {
		return err
	}
	hash, err := auth.HashPassword(run.password)
	if err != nil {
		return err
	}
	if _, err := st.Update(ctx, "users", map[string]any{"password_hash": hash}, store.Eq("id", owner.ID)); err != nil {
		return err
	}
	fmt.Printf("workspace %s is ready; sign in as %s\n", ws.Slug, owner.Email)
	return nil
}

// resetPassword sets a new random password, turns two-step verification
// off and signs every session out.
func (run *adminRun) resetPassword() error {
	ctx, st := run.ctx, run.st
	if len(run.pos) != 1 {
		return errors.New("usage: quadit admin reset-password EMAIL")
	}
	u, err := run.person(run.pos[0])
	if err != nil {
		return err
	}
	pw := auth.Random(12)
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	if _, err := st.Update(ctx, "users", map[string]any{"password_hash": hash, "totp_secret": "", "totp_at": 0}, store.Eq("id", u.ID)); err != nil {
		return err
	}
	if _, err := st.Update(ctx, "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("user_id", u.ID), store.Null("revoked_at")); err != nil {
		return err
	}
	shellAudit(ctx, st, shellAction{action: "password.reset_from_shell", targetType: "user", targetID: u.ID, data: map[string]string{"email": u.Email}})
	fmt.Printf("new password for %s: %s\nTwo-step verification was turned off and every session signed out.\n", u.Email, pw)
	return nil
}

// makeAdmin lets a person run the install.
func (run *adminRun) makeAdmin() error {
	if len(run.pos) != 1 {
		return errors.New("usage: quadit admin make-admin EMAIL")
	}
	u, err := run.person(run.pos[0])
	if err != nil {
		return err
	}
	if _, err := run.st.Update(run.ctx, "users", map[string]any{"is_admin": true}, store.Eq("id", u.ID)); err != nil {
		return err
	}
	shellAudit(run.ctx, run.st, shellAction{action: "user.made_install_admin", targetType: "user", targetID: u.ID, data: map[string]string{"email": u.Email}})
	fmt.Printf("%s can now run the install\n", u.Email)
	return nil
}

// token issues an API token for a member and prints it, once.
func (run *adminRun) token() error {
	ctx, st, pos := run.ctx, run.st, run.pos
	if len(pos) < 2 {
		return errors.New("usage: quadit admin token [--secrets] WORKSPACE @HANDLE [NAME]")
	}
	var ws core.Workspace
	if err := st.Get(ctx, &ws, store.Eq("slug", pos[0]), store.Live); errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no workspace %s", pos[0])
	} else if err != nil {
		return err
	}
	var m core.Member
	if err := st.In(ws.ID).Get(ctx, &m, store.Eq("handle", strings.TrimPrefix(pos[1], "@")), store.Null("removed_at")); errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("no member %s in %s", pos[1], ws.Slug)
	} else if err != nil {
		return err
	}
	token, prefix := auth.NewAPIToken()
	label, scopes := "issued from the shell", ""
	if run.forSecrets {
		scopes = "secrets"
	}
	if len(pos) > 2 {
		label = strings.Join(pos[2:], " ")
	}
	t := core.APIToken{ID: id.New(), WorkspaceID: ws.ID, UserID: m.UserID, Name: label, TokenHash: auth.Hash(token), Prefix: prefix,
		Scopes: scopes, Kind: "token", CreatedBy: m.UserID, CreatedAt: time.Now().UnixMilli()}
	if err := st.Insert(ctx, t); err != nil {
		return err
	}
	shellAudit(ctx, st, shellAction{workspaceID: ws.ID, action: "token.created", targetType: "token", targetID: t.ID, data: map[string]string{"for": m.Handle, "scopes": scopes, "name": label}})
	fmt.Println(token)
	return nil
}

// shellAction is one thing done from the server's own shell, as the audit
// log records it.
type shellAction struct {
	workspaceID          string // empty: the install as a whole
	action               string
	targetType, targetID string
	data                 any
}

// shellAudit writes what was done from the server's own shell to the audit
// log. Nobody is signed in there, so the entry says where it came from.
func shellAudit(ctx context.Context, st store.Store, a shellAction) {
	e := core.AuditEntry{ID: id.New(), At: time.Now().UnixMilli(), WorkspaceID: a.workspaceID, ActorName: "server shell",
		Action: a.action, TargetType: a.targetType, TargetID: a.targetID}
	if u, err := user.Current(); err == nil && u.Username != "" {
		e.ActorName = "server shell (" + u.Username + ")"
	}
	if a.data != nil {
		e.Data, _ = json.Marshal(a.data)
	}
	if err := st.Insert(ctx, e); err != nil {
		fmt.Fprintln(os.Stderr, "audit log:", err)
	}
}
