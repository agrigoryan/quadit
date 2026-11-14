package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/store"
)

// The render check lets an agent see a task or page the way a person does:
// the server opens its own web app in a headless browser, as the caller,
// and returns a picture. It needs Chrome or Chromium on the server.

func init() {
	extraRoutes = append(extraRoutes, func(s *Server, m *http.ServeMux) {
		m.HandleFunc("GET /api/v1/w/{ws}/render", s.in(s.hRender))
		m.HandleFunc("GET /api/v1/auth/render-session", s.open(s.hRenderSession))
	})
}

// findChrome returns a Chrome or Chromium to run, or "".
func findChrome() string {
	if p := os.Getenv("QUADIT_CHROME"); p != "" {
		return p
	}
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "headless-shell"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	if runtime.GOOS == "darwin" {
		for _, p := range []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"} {
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

// hRender returns a PNG of a task or a page as the caller would see it.
// width=390 gives a phone, the default 1280 a desktop.
func (s *Server) hRender(x *c) error {
	chrome := findChrome()
	if chrome == "" {
		return &httpError{Status: 501, Code: "no_browser", Message: "the server has no Chrome or Chromium to take pictures with; install one, or set QUADIT_CHROME to its path"}
	}
	q := x.r.URL.Query()
	width := min(max(x.intParam("width", 1280), 320), 2560)
	height := min(max(x.intParam("height", 0), 0), 8000)
	if height == 0 {
		height = 900
		if width < 600 {
			height = 844
		}
		if truthyParam(q, "full") {
			height = 3000
		}
	}
	path := "/" + x.ws.Slug
	switch {
	case q.Get("task") != "":
		t, err := x.taskByRef(q.Get("task"))
		if err != nil {
			return err
		}
		path += "/task/" + t.Key
	case q.Get("doc") != "":
		d, err := x.docByID(q.Get("doc"))
		if err != nil {
			return err
		}
		path += "/docs/" + d.ID
	case q.Get("path") != "":
		path += "/" + q.Get("path")
	default:
		return errBad("say what to picture: task=KEY, doc=ID or path=…")
	}
	// The browser signs in with a link that works once and can only read.
	token, err := s.oneTime(x.ctx(), "render", x.user.ID, nil, time.Minute)
	if err != nil {
		return err
	}
	base := orText(s.cfg.LocalURL, s.cfg.BaseURL)
	target := base + "/api/v1/auth/render-session?token=" + url.QueryEscape(token) + "&next=" + url.QueryEscape(path)
	dir, err := os.MkdirTemp("", "quadit-render-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "page.png")
	args := []string{"--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--user-data-dir=" + filepath.Join(dir, "profile"),
		fmt.Sprintf("--window-size=%d,%d", width, height), "--virtual-time-budget=6000", "--screenshot=" + out}
	if os.Geteuid() == 0 {
		args = append(args, "--no-sandbox") // Chrome refuses to sandbox as root, as in a container
	}
	if q.Get("theme") == "dark" {
		args = append(args, "--force-dark-mode", "--enable-features=WebContentsForceDark")
	}
	ctx, cancel := context.WithTimeout(x.ctx(), 45*time.Second)
	defer cancel()
	if outp, err := exec.CommandContext(ctx, chrome, append(args, target)...).CombinedOutput(); err != nil {
		s.log.Warn("render", "err", err, "output", oneLine(string(outp), 300))
		return &httpError{Status: 502, Code: "render_failed", Message: "the browser could not take the picture: " + oneLine(err.Error(), 120)}
	}
	png, err := os.ReadFile(out)
	if err != nil {
		return &httpError{Status: 502, Code: "render_failed", Message: "the browser made no picture"}
	}
	x.w.Header().Set("Content-Type", "image/png")
	x.w.Header().Set("Cache-Control", "no-store")
	_, err = x.w.Write(png)
	return err
}

// hRenderSession signs the picture-taking browser in for two minutes,
// read-only, and sends it to the page.
func (s *Server) hRenderSession(x *c) error {
	q := x.r.URL.Query()
	ot, err := s.useOneTime(x.ctx(), "render", q.Get("token"), false)
	if err != nil {
		return err
	}
	token := auth.Random(32)
	now := time.Now()
	sess := core.Session{ID: id.New(), TokenHash: auth.Hash(token), UserID: ot.UserID, Stage: "render", IP: clientIP(x.r), UserAgent: "render check",
		CreatedAt: now.UnixMilli(), LastSeenAt: now.UnixMilli(), ExpiresAt: now.Add(2 * time.Minute).UnixMilli()}
	if err := s.st.Insert(x.ctx(), sess); err != nil {
		return err
	}
	http.SetCookie(x.w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode})
	next := q.Get("next")
	if len(next) == 0 || next[0] != '/' || (len(next) > 1 && next[1] == '/') {
		next = "/"
	}
	http.Redirect(x.w, x.r, next, http.StatusFound)
	return nil
}

var _ = store.Live
