package server

// Install settings: reading them, cached, and saving them from the admin area.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/blob"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/mail"
	"github.com/agrigoryan/quadit/internal/store"
)

// Install settings live in the settings table as JSON, set from the admin
// area. Each can also come from the environment, which then wins:
// "auth.google" is read from QUADIT_SETTING_AUTH_GOOGLE as JSON.

// settingSecrets names every setting, with the fields of it that are
// secrets: stored encrypted and never sent back.
var settingSecrets = map[string][]string{
	"install.name":                 nil,
	"auth.password":                nil,
	"auth.passkeys":                nil,
	"auth.registration":            nil,
	"auth.allowed_domains":         nil,
	"auth.require_2fa":             nil,
	"auth.google":                  {"client_secret"},
	"auth.github":                  {"client_secret"},
	"auth.oidc":                    {"client_secret"},
	"mail":                         {"password"},
	"files":                        {"secret_key", "credentials", "account_key"},
	"files.max_mb":                 nil,
	"limits.api_per_minute":        nil,
	"backup":                       nil,
	"metrics.token":                nil,
	"workspaces.anyone_can_create": nil,
	"push":                         {"private_key"},
}

// cachedSetting is a setting as last read. Until until it is answered from
// here; after that it is read again, and kept only as the last good value
// for when the database cannot be read.
type cachedSetting struct {
	raw     json.RawMessage
	fromEnv bool
	until   time.Time
}

// settingFresh is how long a setting read is answered from the cache.
const settingFresh = 3 * time.Second

// settingWhenUnreadable is what a setting that decides access reads as when
// the database cannot be read and no earlier value is known: the answer that
// lets fewer people in. Other settings read as their default then.
var settingWhenUnreadable = map[string]json.RawMessage{
	"auth.password":                json.RawMessage(`false`),
	"auth.passkeys":                json.RawMessage(`false`),
	"auth.registration":            json.RawMessage(`false`),
	"auth.require_2fa":             json.RawMessage(`true`),
	"workspaces.anyone_can_create": json.RawMessage(`false`),
}

func envName(setting string) string {
	return "QUADIT_SETTING_" + strings.ToUpper(strings.NewReplacer(".", "_").Replace(setting))
}

// loadSetting returns a setting's JSON with its secrets readable, from the
// environment or the database. A read is cached for settingFresh, so reading
// a setting on every request costs nothing. err is set when the database
// could not be read; raw is then the last good value, or, when there is
// none, what settingWhenUnreadable says. A failed read is not cached.
func (s *Server) loadSetting(ctx context.Context, name string) (raw json.RawMessage, fromEnv bool, err error) {
	s.settingsMu.Lock()
	cached, known := s.settingsCache[name]
	s.settingsMu.Unlock()
	if known && time.Now().Before(cached.until) {
		return cached.raw, cached.fromEnv, nil
	}
	raw, fromEnv, err = s.readSetting(ctx, name)
	if err != nil {
		if known {
			return cached.raw, cached.fromEnv, err
		}
		return settingWhenUnreadable[name], false, err
	}
	s.cacheSetting(name, cachedSetting{raw: raw, fromEnv: fromEnv, until: time.Now().Add(settingFresh)})
	return raw, fromEnv, nil
}

// readSetting reads a setting from the environment or the database, past
// the cache. A setting that is not set is nil, without an error.
func (s *Server) readSetting(ctx context.Context, name string) (json.RawMessage, bool, error) {
	if v := os.Getenv(envName(name)); v != "" {
		raw := json.RawMessage(v)
		if !json.Valid(raw) { // a bare word is taken as a string
			quoted, err := json.Marshal(v)
			if err != nil {
				return nil, true, err
			}
			raw = quoted
		}
		return raw, true, nil
	}
	var row core.Setting
	err := s.st.Get(ctx, &row, store.Eq("name", name))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, false, nil
	case err != nil:
		return nil, false, fmt.Errorf("reading the setting %s: %w", name, err)
	}
	return s.unsealFields(name, row.Value), false, nil
}

// cacheSetting keeps a setting as read or saved.
func (s *Server) cacheSetting(name string, cs cachedSetting) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if s.settingsCache == nil {
		s.settingsCache = map[string]cachedSetting{}
	}
	s.settingsCache[name] = cs
}

// rawSetting is loadSetting for callers that cannot act on a failed read:
// the failure is logged, and the value is what loadSetting gives then.
func (s *Server) rawSetting(ctx context.Context, name string) (json.RawMessage, bool) {
	raw, fromEnv, err := s.loadSetting(ctx, name)
	if err != nil {
		s.log.Error("setting unreadable; using the last good value or the safe default", "setting", name, "err", err)
	}
	return raw, fromEnv
}

// unsealFields decrypts the secret fields of a setting's stored JSON. A
// field that does not decrypt is left as it is.
func (s *Server) unsealFields(name string, raw json.RawMessage) json.RawMessage {
	secrets := settingSecrets[name]
	if len(secrets) == 0 || len(raw) == 0 {
		return raw
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return raw
	}
	for _, f := range secrets {
		if v, ok := obj[f].(string); ok && v != "" {
			if plain, err := s.sealer.Open(v); err == nil {
				obj[f] = plain
			}
		}
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return out
}

// setting reads one install setting into dst; a missing one leaves dst
// alone. When the database cannot be read it reads the last good value, or
// for a setting that decides access, the answer that lets fewer people in
// (settingWhenUnreadable), and logs the failure. A check that decides
// access uses checkedSetting instead, to refuse outright.
func (s *Server) setting(ctx context.Context, name string, dst any) bool {
	raw, _ := s.rawSetting(ctx, name)
	return decodeSetting(raw, dst)
}

// checkedSetting is setting for a check that decides access: when the
// database cannot be read it returns the error, and the caller refuses.
func (s *Server) checkedSetting(ctx context.Context, name string, dst any) error {
	raw, _, err := s.loadSetting(ctx, name)
	if err != nil {
		return err
	}
	decodeSetting(raw, dst)
	return nil
}

// checkedSettingBool is settingBool for a check that decides access.
func (s *Server) checkedSettingBool(ctx context.Context, name string, def bool) (bool, error) {
	err := s.checkedSetting(ctx, name, &def)
	return def, err
}

// decodeSetting reads a setting's JSON into dst, reporting whether it was set.
func decodeSetting(raw json.RawMessage, dst any) bool {
	if len(raw) == 0 {
		return false
	}
	return json.Unmarshal(raw, dst) == nil
}

func (s *Server) settingInt(ctx context.Context, name string, def int) int {
	s.setting(ctx, name, &def)
	return def
}

func (s *Server) settingBool(ctx context.Context, name string, def bool) bool {
	s.setting(ctx, name, &def)
	return def
}

// installName is what the install is called (the install.name setting),
// Quadit when it is not named.
func (s *Server) installName(ctx context.Context) string {
	name := "Quadit"
	s.setting(ctx, "install.name", &name)
	return name
}

const masked = "********"

// saveSetting stores a setting, encrypting its secret fields. A secret sent
// back as the mask, or left out, keeps its stored value.
func (s *Server) saveSetting(ctx context.Context, name string, value json.RawMessage, by string) error {
	secrets, known := settingSecrets[name]
	if !known {
		return errBad("unknown setting %q; settings are: %s", name, strings.Join(slices.Sorted(maps.Keys(settingSecrets)), ", "))
	}
	if !json.Valid(value) {
		return errBad("a setting's value must be JSON")
	}
	if strings.TrimSpace(string(value)) == "null" {
		return s.resetSetting(ctx, name)
	}
	if err := checkSettingShape(name, value); err != nil {
		return err
	}
	if len(secrets) > 0 {
		sealed, err := s.sealSecrets(ctx, name, secrets, value)
		if err != nil {
			return err
		}
		value = sealed
	}
	if name == "files" {
		if err := s.tryFiles(ctx, value); err != nil {
			return err
		}
	}
	err := s.st.Upsert(ctx, core.Setting{Name: name, Value: value, UpdatedAt: time.Now().UnixMilli(), UpdatedBy: by}, "name")
	if err != nil {
		s.forgetSetting(name)
	} else {
		s.settingSaved(name, s.unsealFields(name, value))
	}
	if name == "limits.api_per_minute" {
		s.applyLimits(ctx)
	}
	return err
}

// resetSetting takes a setting back to its default, which a null does.
func (s *Server) resetSetting(ctx context.Context, name string) error {
	_, err := s.st.Delete(ctx, "settings", store.Eq("name", name))
	if err != nil {
		s.forgetSetting(name)
	} else {
		s.settingSaved(name, nil)
	}
	if name == "limits.api_per_minute" {
		s.applyLimits(ctx)
	}
	return err
}

// sealSecrets encrypts the secret fields of a setting's new value. A field
// sent as the mask, or left out, keeps the stored value, so the stored
// value must be read: when it cannot be, the save fails rather than lose
// the secrets.
func (s *Server) sealSecrets(ctx context.Context, name string, secrets []string, value json.RawMessage) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(value, &obj); err != nil {
		return nil, errBad("setting %s must be a JSON object", name)
	}
	old, err := s.storedSetting(ctx, name)
	if err != nil {
		return nil, err
	}
	for _, f := range secrets {
		v, _ := obj[f].(string)
		switch {
		case v == masked || (v == "" && obj[f] == nil):
			if old[f] != nil {
				obj[f] = old[f]
			} else {
				delete(obj, f)
			}
		case v != "":
			sealed, err := s.sealer.Seal(v)
			if err != nil {
				return nil, err
			}
			obj[f] = sealed
		}
	}
	return json.Marshal(obj)
}

// storedSetting reads a setting's stored object as it is in the database,
// secrets sealed; nil when it is not set.
func (s *Server) storedSetting(ctx context.Context, name string) (map[string]any, error) {
	var row core.Setting
	err := s.st.Get(ctx, &row, store.Eq("name", name))
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("reading the setting %s before saving it: %w", name, err)
	}
	var old map[string]any
	if err := json.Unmarshal(row.Value, &old); err != nil {
		return nil, fmt.Errorf("the stored setting %s: %w", name, err)
	}
	return old, nil
}

// tryFiles opens the file store with a new "files" setting before it is
// kept, so a typo in a key does not leave the install unable to store files.
func (s *Server) tryFiles(ctx context.Context, value json.RawMessage) error {
	var fc blob.Config
	if err := json.Unmarshal(s.unsealFields("files", value), &fc); err != nil {
		return errBad("%v", err)
	}
	if err := s.useFiles(ctx, fc); err != nil {
		return errBad("%v", err)
	}
	return nil
}

// applyLimits scales the request limits to the admin's number.
func (s *Server) applyLimits(ctx context.Context) {
	n := max(s.settingInt(ctx, "limits.api_per_minute", defaultAPIPerMinute), minAPIPerMinute)
	s.limits.mu.Lock()
	s.limits.factor = float64(n) / defaultAPIPerMinute
	s.limits.mu.Unlock()
}

// The request limit an admin can set, in requests a minute.
const (
	defaultAPIPerMinute = 1200
	minAPIPerMinute     = 10
)

// maskedSettings returns every setting for the admin area, secrets hidden,
// each marked when the environment sets it.
func (s *Server) maskedSettings(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	for name, secrets := range settingSecrets {
		raw, fromEnv, err := s.loadSetting(ctx, name)
		if err != nil {
			return nil, err
		}
		entry := map[string]any{"from_env": fromEnv}
		if len(raw) > 0 {
			var v any
			if err := json.Unmarshal(raw, &v); err != nil {
				return nil, fmt.Errorf("the setting %s: %w", name, err)
			}
			if obj, ok := v.(map[string]any); ok {
				for _, f := range secrets {
					if sv, _ := obj[f].(string); sv != "" {
						obj[f] = masked
					}
				}
			}
			entry["value"] = v
		}
		out[name] = entry
	}
	return out, nil
}

// sendMail sends one email through the install's mail server.
func (s *Server) sendMail(ctx context.Context, to, subject, text string) error {
	var cfg mail.Config
	s.setting(ctx, "mail", &cfg)
	name := s.installName(ctx)
	html := "<div style=\"font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#111;max-width:560px\">" +
		strings.ReplaceAll(linkify(htmlEscape(text)), "\n", "<br>") + "<p style=\"color:#888;font-size:12px\">" + htmlEscape(name) + "</p></div>"
	return mail.Send(ctx, cfg, mail.Message{To: to, Subject: subject, Text: text, HTML: html})
}

func (s *Server) mailReady(ctx context.Context) bool {
	var cfg mail.Config
	s.setting(ctx, "mail", &cfg)
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

// settingShapes says what each setting holds, so that a value of another
// shape is refused instead of stored: a secret under a wrong key would not
// be recognized as one, and would be shown.
var settingShapes = map[string]func() any{
	"install.name":                 func() any { return new(string) },
	"auth.password":                func() any { return new(bool) },
	"auth.passkeys":                func() any { return new(bool) },
	"auth.registration":            func() any { return new(bool) },
	"auth.require_2fa":             func() any { return new(bool) },
	"workspaces.anyone_can_create": func() any { return new(bool) },
	"auth.allowed_domains":         func() any { return new([]string) },
	"auth.google":                  func() any { return new(oauthSetting) },
	"auth.github":                  func() any { return new(oauthSetting) },
	"auth.oidc":                    func() any { return new(oauthSetting) },
	"mail":                         func() any { return new(mail.Config) },
	"files":                        func() any { return new(blob.Config) },
	"files.max_mb":                 func() any { return new(int) },
	"limits.api_per_minute":        func() any { return new(int) },
	"metrics.token":                func() any { return new(string) },
	"backup":                       func() any { return new(backupSetting) },
	"push":                         func() any { return new(pushKeys) },
}

func checkSettingShape(name string, value json.RawMessage) error {
	mk, ok := settingShapes[name]
	if !ok {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(value))
	dec.DisallowUnknownFields()
	if err := dec.Decode(mk()); err != nil {
		return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: fmt.Sprintf("this is not what the setting %s holds: %s", name, engine.PlainJSON(err))}
	}
	if name == "limits.api_per_minute" {
		var n int
		if json.Unmarshal(value, &n) == nil && n < minAPIPerMinute {
			return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: "the least is 10 requests a minute; null takes it back to the default of 1200"}
		}
	}
	return nil
}

// forgetSetting makes a setting be read again on next use; what was read
// last stays as its last good value.
func (s *Server) forgetSetting(name string) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	if cs, ok := s.settingsCache[name]; ok {
		cs.until = time.Time{}
		s.settingsCache[name] = cs
	}
}

// settingSaved notes a setting just written: it is read again on next use,
// and until then raw is its last good value.
func (s *Server) settingSaved(name string, raw json.RawMessage) {
	s.cacheSetting(name, cachedSetting{raw: raw})
}
