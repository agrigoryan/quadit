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

// get asks a service for u with a bearer token (none when empty).
func get(u, token, accept string, timeout time.Duration) (*http.Response, error) {
	req, err := http.NewRequest("GET", u, nil)
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
func getJSON(u, token string, dst any) (http.Header, error) {
	resp, err := get(u, token, "application/json", 60*time.Second)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s answered %s: %.200s", u, resp.Status, body)
	}
	return resp.Header, json.Unmarshal(body, dst)
}

// getFile fetches a file to path, making its folder.
func getFile(u, token, path string) error {
	resp, err := get(u, token, "", 10*time.Minute)
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
