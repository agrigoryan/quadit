// Package app wires the server together and holds the commands that run
// on the server's machine, next to its data.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
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
)

// Commands are extra server-side commands added by other files.
var Commands = map[string]func(args []string, version string) int{}

// Options say where the data lives. Each can come from a flag or from the
// environment, so scripted installs need no flags.
type Options struct {
	Data    string
	DB      string
	Listen  string
	BaseURL string
}

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func (o *Options) flags(fs *flag.FlagSet) {
	fs.StringVar(&o.Data, "data", env("QUADIT_DATA", "./data"), "directory for the database, files and the install secret (QUADIT_DATA)")
	fs.StringVar(&o.DB, "db", env("QUADIT_DB", ""), "database: a SQLite file path or a postgres:// URL; default is quadit.sqlite in the data directory (QUADIT_DB)")
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
	if raw, err := os.ReadFile(path); err == nil && len(raw) >= 16 {
		return raw, nil
	}
	raw := []byte(auth.Random(32))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return nil, fmt.Errorf("write %s: %w", path, err)
	}
	return raw, nil
}

// Serve runs the server until it is told to stop.
func Serve(args []string, version string) int {
	var o Options
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	o.flags(fs)
	fs.StringVar(&o.Listen, "listen", env("QUADIT_LISTEN", ":4780"), "address to listen on (QUADIT_LISTEN)")
	fs.StringVar(&o.BaseURL, "url", env("QUADIT_BASE_URL", ""), "the address people use to reach the server, e.g. https://quadit.example.com (QUADIT_BASE_URL)")
	jsonLog := fs.Bool("log-json", env("QUADIT_LOG", "") == "json", "write logs as JSON (QUADIT_LOG=json)")
	fs.Parse(args)

	var handler slog.Handler = slog.NewTextHandler(os.Stderr, nil)
	if *jsonLog {
		handler = slog.NewJSONHandler(os.Stderr, nil)
	}
	log := slog.New(handler)
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	st, sealer, err := o.Open(ctx)
	if err != nil {
		log.Error("cannot start", "err", err)
		return 1
	}
	defer st.Close()
	if o.BaseURL == "" {
		host := o.Listen
		if strings.HasPrefix(host, ":") {
			host = "localhost" + host
		}
		o.BaseURL = "http://" + host
	}
	o.BaseURL = strings.TrimRight(o.BaseURL, "/")
	files, err := blob.NewDisk(filepath.Join(o.Data, "files"))
	if err != nil {
		log.Error("file storage", "err", err)
		return 1
	}
	local := o.Listen
	if strings.HasPrefix(local, ":") {
		local = "127.0.0.1" + local
	}
	srv := server.New(server.Config{DataDir: o.Data, BaseURL: o.BaseURL, LocalURL: "http://" + local, Version: version, Log: log}, st, files, sealer)
	if web := WebHandler(); web != nil {
		srv.SetWeb(web)
	}
	go srv.Run(ctx)

	hs := &http.Server{Addr: o.Listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- hs.ListenAndServe() }()
	log.Info("quadit is running", "version", version, "listen", o.Listen, "url", o.BaseURL, "database", st.Dialect(), "files", files.Kind())
	select {
	case err := <-errc:
		log.Error("server stopped", "err", err)
		return 1
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	hs.Shutdown(shut)
	return 0
}

// OpenFiles returns the file store the install is set to use: what the
// "files" setting says, read from the environment or the database, with the
// local disk as the place old files may still be.
func OpenFiles(ctx context.Context, st store.Store, sealer *auth.Sealer, dataDir string) (blob.Store, error) {
	disk, err := blob.NewDisk(filepath.Join(dataDir, "files"))
	if err != nil {
		return nil, err
	}
	var cfg blob.Config
	if v := os.Getenv("QUADIT_SETTING_FILES"); v != "" {
		json.Unmarshal([]byte(v), &cfg)
	} else {
		var set core.Setting
		if st.Get(ctx, &set, store.Eq("name", "files")) == nil {
			json.Unmarshal(set.Value, &cfg)
			for _, f := range []*string{&cfg.SecretKey, &cfg.Credentials, &cfg.AccountKey} {
				if plain, err := sealer.Open(*f); err == nil {
					*f = plain
				}
			}
		}
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

// WebHandler returns the handler that serves the built-in web app, or nil
// when the binary was built without it.
var WebHandler = func() http.Handler { return nil }

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
func Admin(args []string, version string) int {
	if len(args) == 0 {
		fmt.Print(adminHelp)
		return 0
	}
	var o Options
	fs := flag.NewFlagSet("admin "+args[0], flag.ExitOnError)
	o.flags(fs)
	name := fs.String("name", "", "the person's name")
	email := fs.String("email", "", "the person's email")
	password := fs.String("password", "", "the person's password")
	workspace := fs.String("workspace", "", "the workspace's name")
	forSecrets := fs.Bool("secrets", false, "token: for a companion, which may receive secrets marked for an environment")
	// Flags may come before or after the positional arguments.
	var pos, flags []string
	for i := 1; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			flags = append(flags, args[i])
			if name := strings.TrimLeft(args[i], "-"); name == "secrets" {
				continue // a switch: it takes no value
			}
			if !strings.Contains(args[i], "=") && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
			continue
		}
		pos = append(pos, args[i])
	}
	fs.Parse(flags)
	ctx := context.Background()
	st, _, err := o.Open(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer st.Close()
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	person := func(addr string) (core.User, error) {
		var u core.User
		err := st.Get(ctx, &u, store.Eq("email", strings.ToLower(addr)), store.Live)
		if err != nil {
			return u, fmt.Errorf("no person with the email %s", addr)
		}
		return u, nil
	}
	switch args[0] {
	case "setup":
		if err := auth.CheckPasswordRules(*password); err != nil {
			return fail(err)
		}
		if n, _ := st.Count(ctx, "users", store.Eq("kind", core.KindPerson)); n > 0 {
			return fail(errors.New("this install is already set up"))
		}
		eng := engine.New(st)
		slug := strings.ToLower(strings.Join(strings.Fields(*workspace), "-"))
		ws, owner, err := eng.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: *name, OwnerEmail: *email, WorkspaceSlug: slug, WorkspaceName: *workspace})
		if err != nil {
			return fail(err)
		}
		hash, _ := auth.HashPassword(*password)
		if _, err := st.Update(ctx, "users", map[string]any{"password_hash": hash}, store.Eq("id", owner.ID)); err != nil {
			return fail(err)
		}
		fmt.Printf("workspace %s is ready; sign in as %s\n", ws.Slug, owner.Email)
	case "reset-password":
		if len(pos) != 1 {
			return fail(errors.New("usage: quadit admin reset-password EMAIL"))
		}
		u, err := person(pos[0])
		if err != nil {
			return fail(err)
		}
		pw := auth.Random(12)
		hash, _ := auth.HashPassword(pw)
		st.Update(ctx, "users", map[string]any{"password_hash": hash, "totp_secret": "", "totp_at": 0}, store.Eq("id", u.ID))
		st.Update(ctx, "sessions", map[string]any{"revoked_at": time.Now().UnixMilli()}, store.Eq("user_id", u.ID), store.Null("revoked_at"))
		fmt.Printf("new password for %s: %s\nTwo-step verification was turned off and every session signed out.\n", u.Email, pw)
	case "make-admin":
		if len(pos) != 1 {
			return fail(errors.New("usage: quadit admin make-admin EMAIL"))
		}
		u, err := person(pos[0])
		if err != nil {
			return fail(err)
		}
		st.Update(ctx, "users", map[string]any{"is_admin": true}, store.Eq("id", u.ID))
		fmt.Printf("%s can now run the install\n", u.Email)
	case "token":
		if len(pos) < 2 {
			return fail(errors.New("usage: quadit admin token [--secrets] WORKSPACE @HANDLE [NAME]"))
		}
		var ws core.Workspace
		if err := st.Get(ctx, &ws, store.Eq("slug", pos[0]), store.Live); err != nil {
			return fail(fmt.Errorf("no workspace %s", pos[0]))
		}
		var m core.Member
		if err := st.In(ws.ID).Get(ctx, &m, store.Eq("handle", strings.TrimPrefix(pos[1], "@")), store.Null("removed_at")); err != nil {
			return fail(fmt.Errorf("no member %s in %s", pos[1], ws.Slug))
		}
		token, prefix := auth.NewAPIToken()
		label, scopes := "issued from the shell", ""
		if *forSecrets {
			scopes = "secrets"
		}
		if len(pos) > 2 {
			label = strings.Join(pos[2:], " ")
		}
		t := core.APIToken{ID: id.New(), WorkspaceID: ws.ID, UserID: m.UserID, Name: label, TokenHash: auth.Hash(token), Prefix: prefix,
			Scopes: scopes, Kind: "token", CreatedBy: m.UserID, CreatedAt: time.Now().UnixMilli()}
		if err := st.Insert(ctx, t); err != nil {
			return fail(err)
		}
		fmt.Println(token)
	default:
		fmt.Print(adminHelp)
		return 2
	}
	return 0
}
