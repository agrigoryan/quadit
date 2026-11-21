package server

// The desktop app that runs this server (quadit serve --app-key-stdin).
//
// The app makes a key each time it starts the server and hands it over on
// standard input; a request that carries it in X-Quadit-App-Key is that
// app. It alone sets the install up, with the person's name: the owner it
// makes has no email and no password, and is recorded as the install's
// local owner, whom the app then signs in with its key whenever its window
// has no session. Whoever can read the key can read the data directory
// too, so the key gives no more than that already does. Before the app
// sends its server the key or a cookie, the server proves it holds the key
// (handleProveAppKey): another program may answer on the port.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// appKeyRoutes are the requests the app makes with its key.
func (s *Server) appKeyRoutes() []route {
	return []route{
		{"POST /api/v1/auth/app-proof", s.public(s.handleProveAppKey), "The server proves to the desktop app that runs it that it holds the app's key, before the app sends it anything else. Body: {nonce}, base64url text of 22 to 128 characters; answers {proof}: the lower-case hex of HMAC-SHA256 of the nonce under the key. 404 on a server no app runs. No key and no session.", "", "account"},
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

// appKeyed reports whether a request is one of the posts the app makes to
// the server it runs, from its own process, which is no page: setting the
// install up and a session, with its key; the proof, before it sends the
// key (which changes nothing and needs no key). They say nothing of the
// page a browser's write comes from (refuseOtherPages): the key is their
// authority instead. No other request is taken on the key.
func (s *Server) appKeyed(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	switch r.URL.Path {
	case "/api/v1/auth/app-proof":
		return true
	case "/api/v1/auth/setup", "/api/v1/auth/app-session":
		return s.isTheApp(r)
	}
	return false
}

// appProofNonce is what the app sends to be proved: base64url text, 22 to
// 128 characters.
var appProofNonce = regexp.MustCompile(`^[A-Za-z0-9_-]+={0,2}$`)

// handleProveAppKey answers the app's nonce with the HMAC-SHA256 of it
// under the app key, as given on standard input, in lower-case hex: only
// the server the app started can, so another program that took the port
// is never sent the key or a cookie.
func (s *Server) handleProveAppKey(x *c) error {
	if s.cfg.AppKey == "" {
		return errNotFound("an app that runs this server")
	}
	var b struct {
		Nonce string `json:"nonce"`
	}
	if err := x.body(&b); err != nil {
		return err
	}
	if len(b.Nonce) < 22 || len(b.Nonce) > 128 || !appProofNonce.MatchString(b.Nonce) {
		return &engine.Error{Code: engine.CodeInvalid, Field: "nonce", Message: "the nonce is base64url text of 22 to 128 characters"}
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.AppKey))
	mac.Write([]byte(b.Nonce))
	return x.ok(map[string]string{"proof": hex.EncodeToString(mac.Sum(nil))})
}

// localOwnerSetting is the setting that names the install's local owner:
// the person the app made when it set the install up, whom it signs in.
const localOwnerSetting = "install.local_owner"

// setUpByApp makes the install's owner and first workspace as the app asks:
// a name and a workspace name. The owner has no email and no password until
// they add them, to sign in from a browser. The owner is recorded as the
// local owner and daily backups are turned on, as stored settings the
// person can change, in the same transaction: an install set up without
// its local owner would have nobody who can sign in.
func (s *Server) setUpByApp(ctx context.Context, b setupBody) (core.Workspace, core.User, error) {
	if b.Email != "" || b.Password != "" {
		return core.Workspace{}, core.User{}, errBad("the app sets the install up with a name and a workspace name only")
	}
	return s.eng.Bootstrap(ctx, engine.BootstrapArgs{OwnerName: b.Name, WorkspaceSlug: b.WorkspaceSlug, WorkspaceName: b.WorkspaceName, Samples: true,
		Also: func(ctx context.Context, db store.DB, owner core.User) error {
			ownerID, _ := json.Marshal(owner.ID) // a string always encodes
			if err := s.settings.SetIn(ctx, db, localOwnerSetting, ownerID, owner.ID); err != nil {
				return err
			}
			// Hour 0 (UTC): the first time the server runs each day, which on a
			// computer that sleeps is the time it surely has.
			backups, _ := json.Marshal(backupSetting{Enabled: true, Hour: 0, Keep: defaultBackupsKept}) // a plain struct always encodes
			return s.settings.SetIn(ctx, db, "backup", backups, owner.ID)
		}})
}

// handleStartAppSession signs the install's local owner in for the app
// that runs this server: its key is the sign-in, and takes both steps
// (anyone who holds it can read the data directory). Attempts with a wrong
// key are counted as failed sign-ins are.
func (s *Server) handleStartAppSession(x *c) error {
	ctx := x.ctx()
	if s.cfg.AppKey == "" {
		return errNotFound("an app that runs this server")
	}
	if !s.isTheApp(x.r) {
		// A wrong key is a failed sign-in, counted with the others from
		// its address; the right one is never counted, so sign-ins that
		// failed on this computer cannot keep the app out.
		if err := s.throttle(ctx, "login:ip:"+s.clientIP(x.r), signInsPerIP, signInWindow); err != nil {
			return err
		}
		return errForbidden("this is for the app that runs this server")
	}
	var ownerID string
	if err := s.settings.Checked(ctx, localOwnerSetting, &ownerID); err != nil {
		return err
	}
	var owner core.User
	there := false
	if ownerID != "" {
		var err error
		if there, err = store.Find(ctx, s.st, &owner, store.Eq("id", ownerID), store.Eq("kind", core.KindPerson), store.Live); err != nil {
			return err
		}
	}
	if !there {
		return &engine.Error{Code: engine.CodeConflict, Message: "this install has no local owner (it was set up with the form); sign in instead"}
	}
	if owner.DisabledAt != 0 {
		return errForbidden("the install's local owner is disabled")
	}
	if _, err := s.signIn(x, owner, "app", true); err != nil {
		return err
	}
	x.w.WriteHeader(http.StatusNoContent)
	return nil
}
