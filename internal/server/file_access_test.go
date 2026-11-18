package server_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/agrigoryan/quadit/internal/store"
	"github.com/agrigoryan/quadit/internal/testdb"
)

// TestUploadsNeedACallerWhoMayWrite: a file is written only by a caller who
// may write, by the credential and by the membership alike, for the first
// part of an upload and for each part after it.
func TestUploadsNeedACallerWhoMayWrite(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		s.change(s.owner, "", "agent.create", M{"name": "Reader", "handle": "reader", "scope": M{"read_only": true}})
		var reader, readOnly struct{ Token string }
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "@reader"}, 201, &reader)
		s.call(s.owner, "", "POST", w+"/tokens", M{"user": "me", "read_only": true}, 201, &readOnly)

		s.call(nil, reader.Token, "POST", "/api/v1/w/-/files?name=a.txt", []byte("hello"), 403, nil)
		s.call(nil, readOnly.Token, "POST", "/api/v1/w/-/files?name=a.txt", []byte("hello"), 403, nil)
		var f struct{ ID string }
		s.call(s.owner, "", "POST", w+"/files?name=b.txt&size=10", []byte("hello"), 201, &f)
		s.call(nil, readOnly.Token, "PATCH", "/api/v1/w/-/files/"+f.ID+"?offset=5", []byte("world"), 403, nil)
		s.call(s.owner, "", "PATCH", w+"/files/"+f.ID+"?offset=5", []byte("world"), 200, nil)
	})
}

// TestAFileIsCheckedAgainEachTimeItIsShown: the browser may keep a file's
// bytes, but asks the server each time it shows them, so one who signed
// out, or lost access, is not shown it from the browser's cache.
func TestAFileIsCheckedAgainEachTimeItIsShown(t *testing.T) {
	testdb.Each(t, func(t *testing.T, st store.Store) {
		s := newSite(t, st)
		var f struct{ URL string }
		s.call(s.owner, "", "POST", w+"/files?name=c.txt", []byte("private words"), 201, &f)
		get := func(etag string) *http.Response {
			t.Helper()
			req, _ := http.NewRequest(http.MethodGet, f.URL, nil)
			if etag != "" {
				req.Header.Set("If-None-Match", etag)
			}
			resp, err := s.owner.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			return resp
		}
		first := get("")
		cache := first.Header.Get("Cache-Control")
		if first.StatusCode != http.StatusOK || strings.Contains(cache, "immutable") || !strings.Contains(cache, "no-cache") || !strings.Contains(cache, "private") {
			t.Fatalf("a file is sent with %d, Cache-Control %q", first.StatusCode, cache)
		}
		etag := first.Header.Get("ETag")
		if etag == "" {
			t.Fatal("a file is sent without an ETag to check it again by")
		}
		if again := get(etag); again.StatusCode != http.StatusNotModified {
			t.Fatalf("checking a kept file again answered %d, want 304", again.StatusCode)
		}
		s.call(s.owner, "", "POST", "/api/v1/auth/logout", nil, 200, nil)
		if out := get(etag); out.StatusCode != http.StatusUnauthorized {
			t.Fatalf("a signed-out browser checking a kept file got %d", out.StatusCode)
		}
	})
}
