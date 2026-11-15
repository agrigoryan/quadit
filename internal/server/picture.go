package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/agrigoryan/quadit/internal/auth"
	"github.com/agrigoryan/quadit/internal/core"
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
	// The browser signs in with a link that works once and can only read.
	token, err := s.oneTime(x.ctx(), core.OneTimeRender, x.user.ID, nil, time.Minute)
	if err != nil {
		return err
	}
	base := firstNonEmpty(s.cfg.LocalURL, s.cfg.BaseURL)
	target := base + "/api/v1/auth/render-session?token=" + url.QueryEscape(token) + "&next=" + url.QueryEscape(path)
	ctx, cancel := context.WithTimeout(x.ctx(), pictureTimeout)
	defer cancel()
	png, whole, err := picture.Take(ctx, picture.Request{Target: target,
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

// picturePath is the web app's address of what the picture is of: a task,
// a page, or any path in the workspace.
func picturePath(x *c) (string, error) {
	q := x.r.URL.Query()
	path := "/" + x.ws.Slug
	switch {
	case q.Get("task") != "":
		t, err := x.taskByRef(x.ctx(), q.Get("task"))
		if err != nil {
			return "", err
		}
		return path + "/task/" + t.Key, nil
	case q.Get("doc") != "":
		d, err := x.docByID(x.ctx(), q.Get("doc"))
		if err != nil {
			return "", err
		}
		return path + "/docs/" + d.ID, nil
	case q.Get("path") != "":
		return path + "/" + q.Get("path"), nil
	}
	return "", errBad("say what to picture: task=KEY, doc=ID or path=…")
}

// handleSignInPictureBrowser signs the picture-taking browser in for two minutes,
// read-only, and sends it to the page.
func (s *Server) handleSignInPictureBrowser(x *c) error {
	q := x.r.URL.Query()
	ot, err := s.useOneTime(x.ctx(), core.OneTimeRender, q.Get("token"), false)
	if err != nil {
		return err
	}
	token := auth.Random(32)
	now := time.Now()
	sess := core.Session{ID: id.New(), TokenHash: auth.Hash(token), UserID: ot.UserID, Stage: core.SessionRender, IP: clientIP(x.r), UserAgent: "render check",
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
