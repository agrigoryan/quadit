package plainjson

import (
	"encoding/json"
	"math"
	"testing"
)

func TestMarshalEncodesPlainValues(t *testing.T) {
	got := string(Marshal(map[string]any{"a": []int{1, 2}, "b": json.RawMessage(`{"c":true}`)}))
	if want := `{"a":[1,2],"b":{"c":true}}`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestMarshalPanicsOnAValueThatDoesNotEncode(t *testing.T) {
	for name, v := range map[string]any{"a NaN": math.NaN(), "a function": func() {}, "broken raw JSON": json.RawMessage(`{`)} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("no panic")
				}
			}()
			Marshal(v)
		})
	}
}
