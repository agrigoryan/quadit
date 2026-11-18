package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
	"github.com/agrigoryan/quadit/internal/engine"
	"github.com/agrigoryan/quadit/internal/id"
	"github.com/agrigoryan/quadit/internal/picture"
)

// The render check lets an agent see a task or page the way a person does:
// the server opens its own web app in a headless browser, as the caller,
// and returns a picture. It needs Chrome or Chromium on the server.

// pictureRoutes are the routes of taking a picture of a page, and the sign-in of the browser that takes it.
func (s *Server) pictureRoutes() []route {
	return []route{
		{"GET /api/v1/w/{ws}/render", s.workspaceMember(s.handleTakePicture), "A PNG of a task or page as a person sees it.", "task: key; doc: id; width: 390 for a phone, 1280 for a desktop; height: of the picture, in place of the usual 900 (844 on a phone); full: true for the whole page however long (to 8000); theme: dark", "files"},
		{"GET /api/v1/auth/render-session", s.public(s.handleSignInPictureBrowser), "Used by the server's own browser when it takes a picture of a page.", "token", "account"},
	}
}

// Picture sizes: the default width, and the bounds a caller may ask for.
const (
	desktopWidth     = 1280
	minPictureWidth  = 320
	maxPictureWidth  = 2560
	minPictureHeight = 200
	pictureTimeout   = 45 * time.Second
)

// handleTakePicture returns a PNG of a task or a page as the caller would see it.
// width=390 gives a phone, the default 1280 a desktop.
func (s *Server) handleTakePicture(x *c) error {
	q := x.r.URL.Query()
	width, height, err := pictureSize(x)
	if err != nil {
		return err
	}
	path, err := picturePath(x)
	if err != nil {
		return err
	}
	// The browser signs in with a link that works once, as the caller with
	// no more reach than this request has: this workspace, the projects the
	// caller may read here, and reading only.
	reach := pictureReach{WorkspaceID: x.ws.ID, Scopes: "read"}
	for _, p := range x.projects {
		reach.Scopes += " project:" + p
	}
	token, err := s.oneTime(x.ctx(), core.OneTimeRender, x.user.ID, reach, time.Minute)
	if err != nil {
		return err
	}
	base := firstNonEmpty(s.cfg.LocalURL, s.cfg.BaseURL)
	target := base + "/api/v1/auth/render-session?token=" + url.QueryEscape(token) + "&next=" + url.QueryEscape(path)
	ctx, cancel := context.WithTimeout(x.ctx(), pictureTimeout)
	defer cancel()
	png, whole, err := s.cfg.TakePicture(ctx, picture.Request{Target: target,
		Width: width, Height: height, Dark: q.Get("theme") == "dark", Full: truthyParam(q, "full") && height == 0})
	if errors.Is(err, picture.ErrNoBrowser) {
		return &httpError{Status: 501, Code: "no_browser", Message: "the server has no Chrome or Chromium to take pictures with; install one, or set QUADIT_CHROME to its path"}
	}
	if err != nil {
		s.log.Warn("render", "err", err)
		return &httpError{Status: 502, Code: "render_failed", Message: "the browser could not take the picture: " + oneLine(err.Error(), 120)}
	}
	if whole > picture.MaxHeight {
		// The page goes on below the picture: say so where a caller reads it.
		x.w.Header().Set("X-Quadit-Note", fmt.Sprintf("the page is %d pixels tall; the picture stops at 8000", whole))
	}
	x.w.Header().Set("Content-Type", "image/png")
	x.w.Header().Set("Cache-Control", "no-store")
	_, err = x.w.Write(png)
	return err
}

// pictureSize reads the size a picture is asked for. A height of 0, none
// given, is the usual height of a phone or a desktop.
func pictureSize(x *c) (width, height int, err error) {
	width = x.intParam("width", desktopWidth)
	if width < minPictureWidth || width > maxPictureWidth {
		return 0, 0, errBad("width is from 320 to 2560: 390 for a phone, 1280 for a desktop")
	}
	height = x.intParam("height", 0)
	if height != 0 && (height < minPictureHeight || height > picture.MaxHeight) {
		return 0, 0, errBad("height is from 200 to 8000; leave it out for the usual size, or use full=1 for the whole page")
	}
	return width, height, nil
}

// pictureReach is what a picture's browser may reach, carried by the
// one-time link it signs in with to the session it gets (core.Session's
// WorkspaceID and Scopes).
type pictureReach struct {
	WorkspaceID string `json:"workspace_id"`
	Scopes      string `json:"scopes"`
}

// picturePath is the web app's address of what the picture is of: a task,
// a page, or a path in the workspace. A task or a page, however it is
// named, is one the caller may read; a path stays inside the workspace.
func picturePath(x *c) (string, error) {
	q := x.r.URL.Query()
	task, doc := q.Get("task"), q.Get("doc")
	query := ""
	if p := q.Get("path"); p != "" {
		u, err := url.Parse(p)
		segments := strings.Split(u.Path, "/")
		if err != nil || u.Scheme != "" || u.Host != "" || u.Opaque != "" || strings.Contains(u.Path, "\\") || slices.ContainsFunc(segments, func(seg string) bool {
			return seg == "" || seg == "." || seg == ".."
		}) {
			return "", errBad("path is a page of the workspace, like tasks or docs/ID, with no .. or // in it")
		}
		switch {
		case len(segments) == 2 && segments[0] == "task":
			task = segments[1]
		case len(segments) == 2 && segments[0] == "docs":
			doc = segments[1]
		default:
			if u.RawQuery != "" {
				query = "?" + u.RawQuery
			}
			return "/" + x.ws.Slug + "/" + u.Path + query, nil
		}
	}
	switch {
	case task != "":
		t, err := x.taskByRef(x.ctx(), task)
		if err != nil {
			return "", err
		}
		return "/" + x.ws.Slug + "/task/" + t.Key, nil
	case doc != "":
		d, err := x.docByID(x.ctx(), doc)
		if err != nil {
			return "", err
		}
		return "/" + x.ws.Slug + "/docs/" + d.ID, nil
	}
	return "", errBad("say what to picture: task=KEY, doc=ID or path=…")
}

// handleSignInPictureBrowser signs the picture-taking browser in for two minutes,
// read-only and with the reach of the request that asked for the picture,
// and sends it to the page.
func (s *Server) handleSignInPictureBrowser(x *c) error {
	q := x.r.URL.Query()
	ot, err := s.useOneTime(x.ctx(), core.OneTimeRender, q.Get("token"), false)
	if err != nil {
		return err
	}
	var reach pictureReach
	if err := json.Unmarshal(ot.Data, &reach); err != nil || reach.WorkspaceID == "" {
		// A link with no reach written in it lets the browser into nothing.
		return &engine.Error{Code: engine.CodeNotFound, Message: "this link is no longer valid; ask for a new one"}
	}
	token := auth.Random(32)
	now := time.Now()
	sess := core.Session{ID: id.New(), TokenHash: auth.Hash(token), UserID: ot.UserID, Stage: core.SessionRender, WorkspaceID: reach.WorkspaceID,
		Scopes: reach.Scopes, IP: s.clientIP(x.r), UserAgent: "render check",
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
