// Package settings keeps the install's settings: named JSON values set from
// the admin area, read on many requests. Get and Checked read one, Set
// stores one, List gives them all for the admin area.
//
// It hides where a value comes from (an environment variable, which wins,
// or the settings table), the few seconds a read is kept, the sealing of
// secret fields (stored encrypted, never shown, kept when sent back
// masked), the check that a value has the setting's shape, and what a
// setting reads as when the database cannot be read: its last good value,
// or else, for one that decides access, the answer that lets fewer people
// in. Which settings there are, and the work around saving one, are the
// caller's: the Table given to New.
//
// It is one file: the table's row, then reading, then saving.
package settings

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/store"
)

// Kind is one setting: what it holds and how it is kept.
type Kind struct {
	// Shape makes a value of what the setting holds. A value of another
	// shape is refused instead of stored: a secret under a wrong key would
	// not be known as one, and would be shown.
	Shape func() any
	// Secrets are the fields stored sealed and never sent back. A field of
	// an object inside the setting is named by its path: "bucket.secret_key".
	Secrets []string
	// WhenUnreadable is what a setting that decides access reads as when
	// the database cannot be read and no earlier value is known: the answer
	// that lets fewer people in. Nil for the others, which then read as
	// their default.
	WhenUnreadable json.RawMessage
	// Check, when set, is asked about a new value before it is stored, with
	// its secrets readable; an error refuses the value.
	Check func(ctx context.Context, value json.RawMessage) error
	// Changed, when set, runs after a value is stored or reset, or failed
	// to be.
	Changed func(ctx context.Context)
}

// Table is every setting, by name.
type Table map[string]Kind

// Settings reads and stores the settings of one install.
type Settings struct {
	st     store.Store
	sealer *auth.Sealer
	log    *slog.Logger
	table  Table

	mu    sync.Mutex        // guards cache
	cache map[string]cached // settings read or saved in the last few seconds
}

// cached is a setting as last read. Until until it is answered from here;
// after that it is read again, and kept only as the last good value for
// when the database cannot be read.
type cached struct {
	raw     json.RawMessage
	fromEnv bool
	until   time.Time
}

// fresh is how long a setting read is answered from the cache.
const fresh = 3 * time.Second

// masked is what a secret field reads as in List, and what, sent back to
// Set, keeps the stored secret.
const masked = "********"

// New keeps the settings of table in st, sealing secrets with sealer. A
// read that fails is logged to log.
func New(st store.Store, sealer *auth.Sealer, log *slog.Logger, table Table) *Settings {
	return &Settings{st: st, sealer: sealer, log: log, table: table, cache: map[string]cached{}}
}

// EnvName is the environment variable that sets a setting, and wins over
// the stored value: "auth.google" is QUADIT_SETTING_AUTH_GOOGLE, as JSON.
func EnvName(setting string) string {
	return "QUADIT_SETTING_" + strings.ToUpper(strings.NewReplacer(".", "_").Replace(setting))
}

// Get reads a setting into dst and reports whether it is set; one that is
// not leaves dst alone. When the database cannot be read it reads the last
// good value, or for a setting that decides access the answer that lets
// fewer people in, and logs the failure. A check that decides access uses
// Checked instead, to refuse outright.
func (s *Settings) Get(ctx context.Context, name string, dst any) bool {
	raw, _, err := s.load(ctx, name)
	if err != nil {
		s.log.Error("setting unreadable; using the last good value or the safe default", "setting", name, "err", err)
	}
	return decode(raw, dst)
}

// Bool is Get of a yes/no setting, def when it is not set.
func (s *Settings) Bool(ctx context.Context, name string, def bool) bool {
	s.Get(ctx, name, &def)
	return def
}

// Checked is Get for a check that decides access: when the database cannot
// be read, or the value set is not of the setting's shape (an environment
// variable written wrong), it returns the error, and the caller refuses.
func (s *Settings) Checked(ctx context.Context, name string, dst any) error {
	raw, fromEnv, err := s.load(ctx, name)
	if err != nil {
		return err
	}
	if len(raw) > 0 && !decode(raw, dst) {
		where := "stored"
		if fromEnv {
			where = "in " + EnvName(name)
		}
		return fmt.Errorf("the setting %s %s does not read as what it holds", name, where)
	}
	return nil
}

// CheckedBool is Checked of a yes/no setting, def when it is not set.
func (s *Settings) CheckedBool(ctx context.Context, name string, def bool) (bool, error) {
	err := s.Checked(ctx, name, &def)
	return def, err
}

// FromEnv reports whether the environment sets a setting, so that storing
// it would change nothing.
func (s *Settings) FromEnv(ctx context.Context, name string) bool {
	_, fromEnv, _ := s.load(ctx, name) // unreadable from the database means not from the environment
	return fromEnv
}

// decode reads a setting's JSON into dst, reporting whether it was set.
func decode(raw json.RawMessage, dst any) bool {
	if len(raw) == 0 {
		return false
	}
	return json.Unmarshal(raw, dst) == nil
}

// load returns a setting's JSON with its secrets readable, from the
// environment or the database. A read is kept for fresh, so reading a
// setting on every request costs nothing. err is set when the database
// could not be read; raw is then the last good value, or, when there is
// none, the setting's WhenUnreadable. A failed read is not kept.
func (s *Settings) load(ctx context.Context, name string) (raw json.RawMessage, fromEnv bool, err error) {
	s.mu.Lock()
	last, known := s.cache[name]
	s.mu.Unlock()
	if known && time.Now().Before(last.until) {
		return last.raw, last.fromEnv, nil
	}
	raw, fromEnv, err = s.read(ctx, name)
	if err != nil {
		if known {
			return last.raw, last.fromEnv, err
		}
		return s.table[name].WhenUnreadable, false, err
	}
	s.keep(name, cached{raw: raw, fromEnv: fromEnv, until: time.Now().Add(fresh)})
	return raw, fromEnv, nil
}

// misspelled names a field of value spelled other than its shape spells
// it once decoded into shaped (JSON matches field names in any letter
// case), or is empty when there is none. A secret is found by its exact
// name, so one spelled otherwise would be stored and listed in the clear.
func misspelled(value json.RawMessage, shaped any) string {
	canonical, err := json.Marshal(shaped)
	if err != nil {
		return ""
	}
	var given, want any
	_ = json.Unmarshal(value, &given)    // decoded into shaped already
	_ = json.Unmarshal(canonical, &want) // just encoded
	return misspelledIn(given, want, "")
}

// misspelledIn is misspelled for one object, at the path at.
func misspelledIn(given, want any, at string) string {
	obj, _ := given.(map[string]any)
	shape, _ := want.(map[string]any)
	for k, v := range obj {
		w, there := shape[k]
		if !there {
			return at + k
		}
		if bad := misspelledIn(v, w, at+k+"."); bad != "" {
			return bad
		}
	}
	return ""
}

// read reads a setting from the environment or the database, past the
// cache. A setting that is not set is nil, without an error.
func (s *Settings) read(ctx context.Context, name string) (json.RawMessage, bool, error) {
	if v := os.Getenv(EnvName(name)); v != "" {
		raw := json.RawMessage(v)
		if !json.Valid(raw) { // a bare word is taken as a string
			quoted, err := json.Marshal(v)
			if err != nil {
				return nil, true, err
			}
			raw = quoted
		}
		// Secrets are found by their exact names; read in the setting's shape
		// first, a field given in another letter case is named as they are.
		if shaped := s.table[name].Shape(); json.Unmarshal(raw, shaped) == nil {
			if canonical, err := json.Marshal(shaped); err == nil {
				raw = canonical
			}
		}
		return raw, true, nil
	}
	var row core.Setting
	there, err := store.Find(ctx, s.st, &row, store.Eq("name", name))
	switch {
	case err != nil:
		return nil, false, fmt.Errorf("reading the setting %s: %w", name, err)
	case !there:
		return nil, false, nil
	}
	return s.unseal(name, row.Value), false, nil
}

// keep caches a setting as read or saved.
func (s *Settings) keep(name string, c cached) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache[name] = c
}

// forget makes a setting be read again on next use; what was read last
// stays as its last good value.
func (s *Settings) forget(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.cache[name]; ok {
		c.until = time.Time{}
		s.cache[name] = c
	}
}

// unseal decrypts the secret fields of a setting's stored JSON. A field
// that does not decrypt is left as it is.
func (s *Settings) unseal(name string, raw json.RawMessage) json.RawMessage {
	secrets := s.table[name].Secrets
	if len(secrets) == 0 || len(raw) == 0 {
		return raw
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return raw
	}
	for _, path := range secrets {
		holder, f := field(obj, path)
		if v, ok := holder[f].(string); ok && v != "" {
			if plain, err := s.sealer.Open(v); err == nil {
				holder[f] = plain
			}
		}
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return out
}

// List returns every setting for the admin area, secrets masked, each
// marked when the environment sets it.
func (s *Settings) List(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	for name, kind := range s.table {
		raw, fromEnv, err := s.load(ctx, name)
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
				for _, path := range kind.Secrets {
					holder, f := field(obj, path)
					if sv, _ := holder[f].(string); sv != "" {
						holder[f] = masked
					}
				}
			}
			entry["value"] = v
		}
		out[name] = entry
	}
	return out, nil
}

// Set stores a setting, sealing its secret fields; null takes it back to
// its default. A secret sent back as the mask, or left out, keeps its
// stored value. The setting's Check is asked first, and its Changed runs
// after, whether the write succeeded or not.
func (s *Settings) Set(ctx context.Context, name string, value json.RawMessage, by string) error {
	kind, known := s.table[name]
	if !known {
		return invalid("", "unknown setting %q; settings are: %s", name, strings.Join(slices.Sorted(maps.Keys(s.table)), ", "))
	}
	if !json.Valid(value) {
		return invalid("", "a setting's value must be JSON")
	}
	if strings.TrimSpace(string(value)) == "null" {
		_, err := s.st.Delete(ctx, "settings", store.Eq("name", name))
		s.saved(ctx, name, kind, nil, err)
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(value))
	dec.DisallowUnknownFields()
	shaped := kind.Shape()
	if err := dec.Decode(shaped); err != nil {
		return invalid(name, "this is not what the setting %s holds: %s", name, engine.PlainJSON(err))
	}
	if field := misspelled(value, shaped); field != "" {
		return invalid(name, "the setting %s has no field %q; field names are spelled as documented, in lower case", name, field)
	}
	if len(kind.Secrets) > 0 {
		sealed, err := s.seal(ctx, name, kind.Secrets, value)
		if err != nil {
			return err
		}
		value = sealed
	}
	if kind.Check != nil {
		if err := kind.Check(ctx, s.unseal(name, value)); err != nil {
			return err
		}
	}
	err := s.st.Upsert(ctx, core.Setting{Name: name, Value: value, UpdatedAt: time.Now().UnixMilli(), UpdatedBy: by}, "name")
	s.saved(ctx, name, kind, s.unseal(name, value), err)
	return err
}

// saved notes a setting just written, as raw: it is read again on next use,
// and until then raw is its last good value. A write that failed leaves
// the last good value as it was. Then the setting's Changed runs.
func (s *Settings) saved(ctx context.Context, name string, kind Kind, raw json.RawMessage, err error) {
	if err != nil {
		s.forget(name)
	} else {
		s.keep(name, cached{raw: raw})
	}
	if kind.Changed != nil {
		kind.Changed(ctx)
	}
}

// seal encrypts the secret fields of a setting's new value. A field sent
// as the mask, or left out, keeps the stored value, so the stored value
// must be read: when it cannot be, the save fails rather than lose the
// secrets.
func (s *Settings) seal(ctx context.Context, name string, secrets []string, value json.RawMessage) (json.RawMessage, error) {
	var obj map[string]any
	if err := json.Unmarshal(value, &obj); err != nil {
		return nil, invalid("", "setting %s must be a JSON object", name)
	}
	old, err := s.stored(ctx, name)
	if err != nil {
		return nil, err
	}
	for _, path := range secrets {
		holder, f := field(obj, path)
		if holder == nil {
			continue // the object that would hold it is not sent
		}
		v, _ := holder[f].(string)
		switch {
		case v == masked || (v == "" && holder[f] == nil):
			if was, wf := field(old, path); was[wf] != nil {
				holder[f] = was[wf]
			} else {
				delete(holder, f)
			}
		case v != "":
			sealed, err := s.sealer.Seal(v)
			if err != nil {
				return nil, err
			}
			holder[f] = sealed
		}
	}
	return json.Marshal(obj)
}

// field finds a secret field by its path: the object in obj that holds it,
// nil when there is none, and its name there.
func field(obj map[string]any, path string) (map[string]any, string) {
	parts := strings.Split(path, ".")
	for _, p := range parts[:len(parts)-1] {
		obj, _ = obj[p].(map[string]any)
	}
	return obj, parts[len(parts)-1]
}

// stored reads a setting's stored object as it is in the database, secrets
// sealed; nil when it is not set.
func (s *Settings) stored(ctx context.Context, name string) (map[string]any, error) {
	var row core.Setting
	there, err := store.Find(ctx, s.st, &row, store.Eq("name", name))
	switch {
	case err != nil:
		return nil, fmt.Errorf("reading the setting %s before saving it: %w", name, err)
	case !there:
		return nil, nil
	}
	var old map[string]any
	if err := json.Unmarshal(row.Value, &old); err != nil {
		return nil, fmt.Errorf("the stored setting %s: %w", name, err)
	}
	return old, nil
}

// invalid refuses a value given for a setting.
func invalid(field, format string, a ...any) error {
	return &engine.Error{Code: engine.CodeInvalid, Field: field, Message: fmt.Sprintf(format, a...)}
}
