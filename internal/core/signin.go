// Sign-in and administration: sessions, identities, passkeys, invites,
// one-time tokens, settings, the audit log, push, OAuth clients, backups
// and rate counters.

package core

import "encoding/json"

// Session stages: how far a browser's sign-in has come.
const (
	SessionFull   = "full"   // signed in
	SessionMFA    = "mfa"    // password given, second factor still to come
	SessionRender = "render" // a short session the server opens to take a picture of a page
)

// One-time token kinds: what a short-lived secret is for.
const (
	OneTimeOAuth           = "oauth"            // the state of a sign-in with a provider
	OneTimeOAuthConsent    = "oauth_consent"    // a consent screen of the server's own OAuth
	OneTimeOAuthCode       = "oauth_code"       // an authorization code of the server's own OAuth
	OneTimePasskeyRegister = "passkey_register" // adding a passkey
	OneTimePasskeyLogin    = "passkey_login"    // signing in with a passkey
	OneTimeRender          = "render"           // opening a render session
	OneTimeReset           = "reset"            // a password reset link
	OneTimeTOTPUsed        = "totp_used"        // marks a TOTP code as spent
)

// Session is one browser signed in as a person.
type Session struct {
	ID         string `json:"id" db:"id"`
	TokenHash  string `json:"-" db:"token_hash"`
	UserID     string `json:"user_id" db:"user_id"`
	Stage      string `json:"stage" db:"stage"` // one of the Session* stages
	IP         string `json:"ip,omitempty" db:"ip"`
	UserAgent  string `json:"user_agent,omitempty" db:"user_agent"`
	CreatedAt  int64  `json:"created_at" db:"created_at"`
	LastSeenAt int64  `json:"last_seen_at" db:"last_seen_at"`
	ExpiresAt  int64  `json:"expires_at" db:"expires_at"`
	RevokedAt  int64  `json:"revoked_at,omitempty" db:"revoked_at,null"`
}

// Identity is a person's account at a sign-in provider.
type Identity struct {
	ID        string `json:"id" db:"id"`
	UserID    string `json:"user_id" db:"user_id"`
	Provider  string `json:"provider" db:"provider"`
	Subject   string `json:"-" db:"subject"` // the provider's id for the person
	Email     string `json:"email,omitempty" db:"email"`
	CreatedAt int64  `json:"created_at" db:"created_at"`
}

// Passkey is a WebAuthn credential a person signs in with.
type Passkey struct {
	ID           string          `json:"id" db:"id"`
	UserID       string          `json:"user_id" db:"user_id"`
	Name         string          `json:"name" db:"name"`
	CredentialID string          `json:"-" db:"credential_id"`
	Credential   json.RawMessage `json:"-" db:"credential,json"`
	CreatedAt    int64           `json:"created_at" db:"created_at"`
	LastUsedAt   int64           `json:"last_used_at,omitempty" db:"last_used_at,null"`
}

// RecoveryCode is a single-use code that stands in for a second factor.
type RecoveryCode struct {
	ID        string `db:"id"`
	UserID    string `db:"user_id"`
	CodeHash  string `db:"code_hash"`
	CreatedAt int64  `db:"created_at"`
	UsedAt    int64  `db:"used_at,null"`
}

// Invite is a link that lets people join a workspace with a role. It
// stops working when it expires, is used MaxUses times or is revoked.
type Invite struct {
	ID          string `json:"id" db:"id"`
	WorkspaceID string `json:"workspace_id" db:"workspace_id"`
	Email       string `json:"email,omitempty" db:"email"` // whom it was sent to, if anyone
	Role        Role   `json:"role" db:"role"`
	TokenHash   string `json:"-" db:"token_hash"`
	CreatedBy   string `json:"created_by" db:"created_by"`
	CreatedAt   int64  `json:"created_at" db:"created_at"`
	ExpiresAt   int64  `json:"expires_at" db:"expires_at"`
	MaxUses     int    `json:"max_uses" db:"max_uses"`
	Uses        int    `json:"uses" db:"uses"`
	RevokedAt   int64  `json:"revoked_at,omitempty" db:"revoked_at,null"`
}

// OneTimeToken is a short-lived secret, stored as its hash, with what it
// carries.
type OneTimeToken struct {
	ID        string          `db:"id"`
	Kind      string          `db:"kind"` // one of the OneTime* kinds
	TokenHash string          `db:"token_hash"`
	UserID    string          `db:"user_id,null"`
	Data      json.RawMessage `db:"data,json"`
	CreatedAt int64           `db:"created_at"`
	ExpiresAt int64           `db:"expires_at"`
	UsedAt    int64           `db:"used_at,null"`
}

// Setting is one install-wide setting.
type Setting struct {
	Name      string          `json:"name" db:"name"`
	Value     json.RawMessage `json:"value" db:"value,json"`
	UpdatedAt int64           `json:"updated_at" db:"updated_at"`
	UpdatedBy string          `json:"updated_by,omitempty" db:"updated_by,null"`
}

// AuditEntry is one line of the audit log: who did what to what, from where.
type AuditEntry struct {
	ID          string          `json:"id" db:"id"`
	At          int64           `json:"at" db:"at"`
	WorkspaceID string          `json:"workspace_id,omitempty" db:"workspace_id,null"`
	ActorID     string          `json:"actor_id,omitempty" db:"actor_id,null"`
	ActorName   string          `json:"actor_name,omitempty" db:"actor_name"`
	Action      string          `json:"action" db:"action"`
	TargetType  string          `json:"target_type,omitempty" db:"target_type"`
	TargetID    string          `json:"target_id,omitempty" db:"target_id"`
	IP          string          `json:"ip,omitempty" db:"ip"`
	UserAgent   string          `json:"user_agent,omitempty" db:"user_agent"`
	Data        json.RawMessage `json:"data,omitempty" db:"data,json"`
}

// PushSubscription is a browser that receives web push notifications for
// a person.
type PushSubscription struct {
	ID        string `json:"id" db:"id"`
	UserID    string `json:"user_id" db:"user_id"`
	Endpoint  string `json:"endpoint" db:"endpoint"`
	P256dh    string `json:"-" db:"p256dh"` // the browser's public key
	Auth      string `json:"-" db:"auth"`   // the browser's auth secret
	UserAgent string `json:"user_agent,omitempty" db:"user_agent"`
	CreatedAt int64  `json:"created_at" db:"created_at"`
}

// OAuthClient is an app registered with the server's own OAuth.
type OAuthClient struct {
	ID           string   `json:"client_id" db:"id"`
	Name         string   `json:"client_name" db:"name"`
	RedirectURIs []string `json:"redirect_uris" db:"redirect_uris,json"`
	CreatedAt    int64    `json:"created_at" db:"created_at"`
}

// Backup records one backup of the install: where it went and whether it
// was checked.
type Backup struct {
	ID         string `json:"id" db:"id"`
	StartedAt  int64  `json:"started_at" db:"started_at"`
	FinishedAt int64  `json:"finished_at,omitempty" db:"finished_at,null"`
	Location   string `json:"location,omitempty" db:"location"`
	Size       int64  `json:"size" db:"size"`
	SHA256     string `json:"sha256,omitempty" db:"sha256"`
	VerifiedAt int64  `json:"verified_at,omitempty" db:"verified_at,null"`
	Error      string `json:"error,omitempty" db:"error"`
}

// RateCounter counts hits on one name within one window of time, for rate
// limits.
type RateCounter struct {
	Name string `db:"name"`
	// Bucket is when the window ends, in Unix seconds, whatever its length:
	// limits counted over windows of different lengths share the table, and
	// a window that is over can be cleared without knowing whose it was.
	Bucket int64 `db:"bucket"`
	Hits   int   `db:"hits"`
}
