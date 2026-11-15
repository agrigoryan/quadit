// Fetching from another tool's API: JSON answers and files.

package importer

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// The longest a JSON answer and a file may take to arrive, and the most of
// a JSON answer read.
const (
	jsonTimeout = 60 * time.Second
	fileTimeout = 10 * time.Minute
	jsonLimit   = 64 << 20
)

// get asks a service for u with a bearer token (none when empty).
func get(u, token, accept string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil) //nolint:noctx // Read takes no context for a source to pass on; the client's timeout bounds the request
	if err != nil {
		return nil, err
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	req.Header.Set("User-Agent", "quadit-import")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	hc := http.Client{Timeout: timeout}
	return hc.Do(req)
}

// getJSON reads a JSON answer into dst.
func getJSON(u, token string, dst any) error {
	resp, err := get(u, token, "application/json", jsonTimeout)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, jsonLimit))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s answered %s: %.200s", u, resp.Status, body)
	}
	if err != nil {
		return fmt.Errorf("%s: reading the answer: %w", u, err)
	}
	return json.Unmarshal(body, dst)
}

// getFile fetches a file to path, making its folder.
func getFile(u, token, path string) error {
	resp, err := get(u, token, "", fileTimeout)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s answered %s", u, resp.Status)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	out, err := os.Create(path)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		os.Remove(path)
		return err
	}
	return out.Close()
}
