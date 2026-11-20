package server

// The desktop app that runs this server (quadit serve --app-key-stdin).
//
// The app makes a key each time it starts the server and hands it over on
// standard input; a request that carries it in X-Quadit-App-Key is that
// app. It alone sets the install up, with the person's name: the owner it
// makes has no email and no password, and is recorded as the install's
// local owner, whom the app then signs in with its key whenever its window
// has no session. Whoever can read the key can read the data directory
// too, so the key gives no more than that already does.

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// appKeyRoutes are the requests the app makes with its key.
func (s *Server) appKeyRoutes() []route {
	return []route{
		{"POST /api/v1/auth/app-session", s.public(s.handleStartAppSession), "The desktop app that runs this server signs the install's local owner in, with its key in X-Quadit-App-Key: a session cookie, 204. 403 on a wrong key; 409 on an install set up with the form, which has no local owner; 404 on a server no app runs.", "", "account"},
	}
}

// isTheApp reports whether a request carries the key of the app that runs
// this server. On a server no app runs, none does.
func (s *Server) isTheApp(r *http.Request) bool {
	if s.cfg.AppKey == "" {
		return false
	}
	// Compared as hashes, in constant time: neither the key nor its length
	// can be learned from how long a refusal takes.
	given, want := sha256.Sum256([]byte(r.Header.Get("X-Quadit-App-Key"))), sha256.Sum256([]byte(s.cfg.AppKey))
	return subtle.ConstantTimeCompare(given[:], want[:]) == 1
}

// appKeyed reports whether a request is one of the two the app makes with
// its key: setting the install up, and a session. The app sends them from
// its own process, which is no page, so they say nothing of the page a
// browser's write comes from (refuseOtherPages): the key is their
// authority instead. No other request is taken on the key.
func (s *Server) appKeyed(r *http.Request) bool {
	switch r.URL.Path {
	case "/api/v1/auth/setup", "/api/v1/auth/app-session":
		return s.isTheApp(r)
	}
	return false
}

// localOwnerSetting is the setting that names the install's local owner:
// the person the app made when it set the install up, whom it signs in.
const localOwnerSetting = "install.local_owner"

// setUpByApp makes the install's owner and first workspace as the app asks:
// a name and a workspace name. The owner has no email and no password until
// they add them, to sign in from a browser. Daily backups are turned on, as
// stored settings the person can change.
func (s *Server) setUpByApp(ctx context.Context, b setupBody) (core.Workspace, core.User, error) {
	if b.Email != "" || b.Password != "" {
		return core.Workspace{}, core.User{}, errBad("the app sets the install up with a name and a workspace name only")
	}
	ws, owner, err := s.eng.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: b.Name, WorkspaceSlug: b.WorkspaceSlug, WorkspaceName: b.WorkspaceName})
	if err != nil {
		return ws, owner, err
	}
	ownerID, _ := json.Marshal(owner.ID) // a string always encodes
	if err := s.settings.Set(ctx, localOwnerSetting, ownerID, owner.ID); err != nil {
		return ws, owner, err
	}
	// Hour 0 (UTC): the first time the server runs each day, which on a
	// computer that sleeps is the time it surely has.
	backups, _ := json.Marshal(backupSetting{Enabled: true, Hour: 0, Keep: defaultBackupsKept}) // a plain struct always encodes
	return ws, owner, s.settings.Set(ctx, "backup", backups, owner.ID)
}

// handleStartAppSession signs the install's local owner in for the app
// that runs this server: its key is the sign-in, and takes both steps
// (anyone who holds it can read the data directory). Attempts are counted
// as sign-ins are.
func (s *Server) handleStartAppSession(x *c) error {
	ctx := x.ctx()
	if s.cfg.AppKey == "" {
		return errNotFound("an app that runs this server")
	}
	if err := s.throttle(ctx, "login:ip:"+s.clientIP(x.r), signInsPerIP, signInWindow); err != nil {
		return err
	}
	if !s.isTheApp(x.r) {
		return errForbidden("this is for the app that runs this server")
	}
	var ownerID string
	if err := s.settings.Checked(ctx, localOwnerSetting, &ownerID); err != nil {
		return err
	}
	if ownerID == "" {
		return &engine.Error{Code: engine.CodeConflict, Message: "this install was set up with the form, so it has no local owner; sign in instead"}
	}
	var owner core.User
	there, err := store.Find(ctx, s.st, &owner, store.Eq("id", ownerID), store.Live)
	if err != nil {
		return err
	}
	if !there || owner.DisabledAt != 0 {
		return errForbidden("the install's local owner is gone or disabled")
	}
	if _, err := s.signIn(x, owner, "app", true); err != nil {
		return err
	}
	x.w.WriteHeader(http.StatusNoContent)
	return nil
}
