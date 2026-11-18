package server

// The install's settings as the server knows them (package settings keeps
// them), and sending mail with the "mail" setting.

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/mail"
	"github.com/agrigoryan/quadit/internal/settings"
	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/webpush"
)

// settingKinds is every install setting (package settings keeps them):
// what each holds, which of its fields are secrets, what one that decides
// access reads as when it cannot be read, and the server's work around
// saving two of them.
func (s *Server) settingKinds() settings.Table {
	no, yes := json.RawMessage(`false`), json.RawMessage(`true`)
	return settings.Table{
		"install.name":                 {Shape: func() any { return new(string) }},
		"auth.password":                {Shape: func() any { return new(bool) }, WhenUnreadable: no},
		"auth.passkeys":                {Shape: func() any { return new(bool) }, WhenUnreadable: no},
		"auth.registration":            {Shape: func() any { return new(bool) }, WhenUnreadable: no},
		"auth.require_2fa":             {Shape: func() any { return new(bool) }, WhenUnreadable: yes},
		"workspaces.anyone_can_create": {Shape: func() any { return new(bool) }, WhenUnreadable: no},
		"auth.allowed_domains":         {Shape: func() any { return new([]string) }},
		"auth.google":                  {Shape: func() any { return new(oauthSetting) }, Secrets: []string{"client_secret"}},
		"auth.github":                  {Shape: func() any { return new(oauthSetting) }, Secrets: []string{"client_secret"}},
		"auth.oidc":                    {Shape: func() any { return new(oauthSetting) }, Secrets: []string{"client_secret"}},
		"mail":                         {Shape: func() any { return new(mail.Config) }, Secrets: []string{"password"}},
		"files":                        filesKind(s.tryFiles),
		"files.max_mb":                 {Shape: func() any { return new(int) }},
		"limits.api_per_minute":        {Shape: func() any { return new(int) }, Check: checkAPIPerMinute, Changed: s.applyLimits},
		"metrics.token":                {Shape: func() any { return new(string) }},
		"backup":                       {Shape: func() any { return new(backupSetting) }, Secrets: prefixed("copy_to.bucket.", bucketSecrets), Check: s.checkBackupSetting},
		"push":                         {Shape: func() any { return new(webpush.Keys) }, Secrets: []string{"private_key"}},
	}
}

// filesKind is the "files" setting: where uploaded files are kept, with
// the keys to a cloud store sealed. check, when set, tries a new value
// before it is kept.
func filesKind(check func(ctx context.Context, value json.RawMessage) error) settings.Kind {
	return settings.Kind{Shape: func() any { return new(blob.Config) }, Secrets: bucketSecrets, Check: check}
}

// bucketSecrets are the fields of a blob.Config that are secrets: the keys
// to a cloud store.
var bucketSecrets = []string{"secret_key", "credentials", "account_key"}

// prefixed is each field named as a field of the object at prefix.
func prefixed(prefix string, fields []string) []string {
	out := make([]string, len(fields))
	for i, f := range fields {
		out[i] = prefix + f
	}
	return out
}

// FilesConfig reads the "files" setting as a running server reads it (the
// environment's value wins; the stored one has its keys unsealed), for a
// command run on the server's machine without one: backup and restore. Not
// set, it is the zero Config, the local disk. A database that cannot be
// read is the error.
func FilesConfig(ctx context.Context, st store.Store, sealer *auth.Sealer, log *slog.Logger) (blob.Config, error) {
	var cfg blob.Config
	err := settings.New(st, sealer, log, settings.Table{"files": filesKind(nil)}).Checked(ctx, "files", &cfg)
	return cfg, err
}

// installName is what the install is called (the install.name setting),
// Quadit when it is not named.
func (s *Server) installName(ctx context.Context) string {
	name := "Quadit"
	s.settings.Get(ctx, "install.name", &name)
	return name
}

// tryFiles opens the file store with a new "files" setting before it is
// kept, so a typo in a key does not leave the install unable to store files.
func (s *Server) tryFiles(ctx context.Context, value json.RawMessage) error {
	var fc blob.Config
	if err := json.Unmarshal(value, &fc); err != nil {
		return errBad("%v", err)
	}
	if err := s.useFiles(ctx, fc); err != nil {
		return errBad("%v", err)
	}
	return nil
}

// checkAPIPerMinute refuses a request limit below the least.
func checkAPIPerMinute(_ context.Context, value json.RawMessage) error {
	var n int
	if json.Unmarshal(value, &n) == nil && n < minAPIPerMinute {
		return &engine.Error{Code: engine.CodeInvalid, Field: "limits.api_per_minute", Message: "the least is 10 requests a minute; null takes it back to the default of 1200"}
	}
	return nil
}

// applyLimits scales the request limits to the admin's number.
func (s *Server) applyLimits(ctx context.Context) {
	n := defaultAPIPerMinute
	s.settings.Get(ctx, "limits.api_per_minute", &n)
	n = max(n, minAPIPerMinute)
	s.limits.mu.Lock()
	s.limits.factor = float64(n) / defaultAPIPerMinute
	s.limits.mu.Unlock()
}

// The request limit an admin can set, in requests a minute.
const (
	defaultAPIPerMinute = 1200
	minAPIPerMinute     = 10
)

// sendMail sends one email through the install's mail server.
func (s *Server) sendMail(ctx context.Context, to, subject, text string) error {
	var cfg mail.Config
	s.settings.Get(ctx, "mail", &cfg)
	name := s.installName(ctx)
	html := "<div style=\"font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#111;max-width:560px\">" +
		strings.ReplaceAll(linkify(htmlEscape(text)), "\n", "<br>") + "<p style=\"color:#888;font-size:12px\">" + htmlEscape(name) + "</p></div>"
	return mail.Send(ctx, cfg, mail.Message{To: to, Subject: subject, Text: text, HTML: html})
}

func (s *Server) mailReady(ctx context.Context) bool {
	var cfg mail.Config
	s.settings.Get(ctx, "mail", &cfg)
	return cfg.Ready()
}

func htmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;").Replace(s)
}

// linkify turns the bare URLs in escaped text into links.
func linkify(s string) string {
	words := strings.Split(s, " ")
	for i, w := range words {
		for line := range strings.SplitSeq(w, "\n") {
			if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
				words[i] = strings.Replace(words[i], line, "<a href=\""+line+"\">"+line+"</a>", 1)
			}
		}
	}
	return strings.Join(words, " ")
}
