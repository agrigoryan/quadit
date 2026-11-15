package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
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
// "auth.google" is read from QUADIT_SETTING_AUTH_GOOGLE as JSON. The fields
// listed here are secrets: stored encrypted and never sent back.
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

type cachedSetting struct {
	raw     json.RawMessage
	fromEnv bool
	until   time.Time
}

func envName(setting string) string {
	return "QUADIT_SETTING_" + strings.ToUpper(strings.NewReplacer(".", "_").Replace(setting))
}

// rawSetting returns a setting's JSON with its secrets readable, from the
// environment or the database. It is cached for a few seconds, so reading a
// setting on every request costs nothing.
func (s *Server) rawSetting(ctx context.Context, name string) (json.RawMessage, bool) {
	s.setMu.Lock()
	if cs, ok := s.setTTL[name]; ok && time.Now().Before(cs.until) {
		s.setMu.Unlock()
		return cs.raw, cs.fromEnv
	}
	s.setMu.Unlock()
	var raw json.RawMessage
	fromEnv := false
	if v := os.Getenv(envName(name)); v != "" {
		raw, fromEnv = json.RawMessage(v), true
		if !json.Valid(raw) { // a bare word is taken as a string
			raw, _ = json.Marshal(v)
		}
	} else {
		var st core.Setting
		if err := s.st.Get(ctx, &st, store.Eq("name", name)); err == nil {
			raw = s.unsealFields(name, st.Value)
		}
	}
	s.setMu.Lock()
	if s.setTTL == nil {
		s.setTTL = map[string]cachedSetting{}
	}
	s.setTTL[name] = cachedSetting{raw: raw, fromEnv: fromEnv, until: time.Now().Add(3 * time.Second)}
	s.setMu.Unlock()
	return raw, fromEnv
}

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
	out, _ := json.Marshal(obj)
	return out
}

// setting reads one install setting into dst; a missing one leaves dst alone.
func (s *Server) setting(ctx context.Context, name string, dst any) bool {
	raw, _ := s.rawSetting(ctx, name)
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

func (s *Server) settingStr(ctx context.Context, name, def string) string {
	s.setting(ctx, name, &def)
	return def
}

const masked = "********"

// saveSetting stores a setting, encrypting its secret fields. A secret sent
// back as the mask, or left out, keeps its stored value.
func (s *Server) saveSetting(ctx context.Context, name string, value json.RawMessage, by string) error {
	secrets, known := settingSecrets[name]
	if !known {
		names := make([]string, 0, len(settingSecrets))
		for k := range settingSecrets {
			names = append(names, k)
		}
		sort.Strings(names)
		return errBad("unknown setting %q; settings are: %s", name, strings.Join(names, ", "))
	}
	if !json.Valid(value) {
		return errBad("a setting's value must be JSON")
	}
	if strings.TrimSpace(string(value)) == "null" {
		// null takes the setting back to its default.
		_, err := s.st.Delete(ctx, "settings", store.Eq("name", name))
		s.forgetSetting(name)
		return err
	}
	if err := checkSettingShape(name, value); err != nil {
		return err
	}
	if len(secrets) > 0 {
		var obj map[string]any
		if err := json.Unmarshal(value, &obj); err != nil {
			return errBad("setting %s must be a JSON object", name)
		}
		var old map[string]any
		var st core.Setting
		if err := s.st.Get(ctx, &st, store.Eq("name", name)); err == nil {
			json.Unmarshal(st.Value, &old)
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
					return err
				}
				obj[f] = sealed
			}
		}
		value, _ = json.Marshal(obj)
	}
	if name == "files" {
		// Open the store with the new values before keeping them, so a typo
		// in a key does not leave the install unable to store files.
		var fc blob.Config
		json.Unmarshal(s.unsealFields(name, value), &fc)
		if err := s.useFiles(ctx, fc); err != nil {
			return errBad("%v", err)
		}
	}
	err := s.st.Upsert(ctx, core.Setting{Name: name, Value: value, UpdatedAt: time.Now().UnixMilli(), UpdatedBy: by}, "name")
	s.setMu.Lock()
	delete(s.setTTL, name)
	s.setMu.Unlock()
	if name == "limits.api_per_minute" {
		s.applyLimits(ctx)
	}
	return err
}

// applyLimits scales the request limits to the admin's number.
func (s *Server) applyLimits(ctx context.Context) {
	n := s.settingInt(ctx, "limits.api_per_minute", 1200)
	if n < 10 {
		n = 10
	}
	s.limits.mu.Lock()
	s.limits.factor = float64(n) / 1200
	s.limits.mu.Unlock()
}

// maskedSettings returns every setting for the admin area, secrets hidden,
// each marked when the environment sets it.
func (s *Server) maskedSettings(ctx context.Context) map[string]any {
	out := map[string]any{}
	for name, secrets := range settingSecrets {
		raw, fromEnv := s.rawSetting(ctx, name)
		entry := map[string]any{"from_env": fromEnv}
		if len(raw) > 0 {
			var v any
			json.Unmarshal(raw, &v)
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
	return out
}

// sendMail sends one email through the install's mail server.
func (s *Server) sendMail(ctx context.Context, to, subject, text string) error {
	var cfg mail.Config
	s.setting(ctx, "mail", &cfg)
	name := s.settingStr(ctx, "install.name", "Quadit")
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
		for _, line := range strings.Split(w, "\n") {
			if strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://") {
				words[i] = strings.Replace(words[i], line, "<a href=\""+line+"\">"+line+"</a>", 1)
			}
		}
	}
	return strings.Join(words, " ")
}

// settingShapes says what each setting holds, so that a value of another
// shape is refused instead of stored: a secret under a wrong key would not
// be recognised as one, and would be shown.
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
		return &engine.Error{Code: engine.CodeInvalid, Field: name, Message: fmt.Sprintf("this is not what the setting %s holds: %s", name, strings.TrimPrefix(err.Error(), "json: "))}
	}
	return nil
}

// forgetSetting drops a setting from the short-lived cache.
func (s *Server) forgetSetting(name string) {
	s.setMu.Lock()
	delete(s.setTTL, name)
	s.setMu.Unlock()
}
