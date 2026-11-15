package engine

import (
	"bytes"
	"encoding/json"
)

// Opt is an optional argument that tells "absent" from "null" from a value,
// which a patch needs: absent leaves the field alone, null clears it.
type Opt[T any] struct {
	Set  bool
	Null bool
	V    T
}

func (o *Opt[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(bytes.TrimSpace(b)) == "null" {
		o.Null = true
		return nil
	}
	// As strict as the arguments around it: a misspelled field inside is
	// refused, not dropped.
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	return dec.Decode(&o.V)
}

func (o Opt[T]) MarshalJSON() ([]byte, error) {
	if !o.Set || o.Null {
		return []byte("null"), nil
	}
	return json.Marshal(o.V)
}
