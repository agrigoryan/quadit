package server

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"time"

	"github.com/agrigoryan/quadit/internal/plainjson"
)

// The picture is taken by driving the browser over its debugging pipe, not
// by sizing a window: a headless window has a minimum width and loses part
// of its height to a title bar it does not draw, so a "390 wide" window lays
// the page out wider and shorter than asked. Device emulation gives exactly
// the asked size, and tells the page it is a phone when it is one.

// cdpMsg is one message of the DevTools protocol, either way.
type cdpMsg struct {
	ID        int             `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *cdpError       `json:"error,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
}

// cdpError is the error a command ends in.
type cdpError struct {
	Message string `json:"message"`
}

// cdp speaks to one browser. It is used from one goroutine.
type cdp struct {
	out    *os.File
	in     chan cdpMsg
	next   int
	events []cdpMsg // events read while waiting for an answer
}

// read waits for the next message from the browser.
func (c *cdp) read(ctx context.Context) (cdpMsg, error) {
	select {
	case m, ok := <-c.in:
		if !ok {
			return m, errors.New("the browser went away")
		}
		return m, nil
	case <-ctx.Done():
		return cdpMsg{}, ctx.Err()
	}
}

// call sends a command and returns its result.
func (c *cdp) call(ctx context.Context, session, method string, params any) (json.RawMessage, error) {
	c.next++
	id := c.next
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	b := plainjson.Marshal(cdpMsg{ID: id, Method: method, Params: raw, SessionID: session})
	if _, err := c.out.Write(append(b, 0)); err != nil {
		return nil, err
	}
	for {
		m, err := c.read(ctx)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", method, err)
		}
		if m.ID != id {
			if m.ID == 0 {
				c.events = append(c.events, m)
			}
			continue
		}
		if m.Error != nil {
			return nil, fmt.Errorf("%s: %s", method, m.Error.Message)
		}
		return m.Result, nil
	}
}

// event waits for an event that ok accepts, among those already read and
// those still to come. It gives up quietly at the deadline.
func (c *cdp) event(ctx context.Context, wait time.Duration, ok func(cdpMsg) bool) bool {
	if slices.ContainsFunc(c.events, ok) {
		return true
	}
	c.events = nil
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	for {
		m, err := c.read(ctx)
		if err != nil {
			return false
		}
		if m.ID == 0 && ok(m) {
			return true
		}
	}
}

// evalTrue evaluates a JavaScript expression in the page.
func (c *cdp) evalTrue(ctx context.Context, session, js string) bool {
	res, err := c.call(ctx, session, "Runtime.evaluate", map[string]any{"expression": js, "returnByValue": true})
	if err != nil {
		return false
	}
	var out struct {
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
	}
	if json.Unmarshal(res, &out) != nil {
		return false
	}
	return out.Result.Value == true
}

// pageSettled is true when the web app has its data and nothing visible is
// still arriving. A page that is not the web app has no data mark; it counts
// as settled once its pictures and fonts are in.
const pageSettled = `(() => {
  const root = document.documentElement;
  if (document.getElementById("root") && root.dataset.loaded !== "1") return false;
  if (document.fonts && document.fonts.status !== "loaded") return false;
  return Array.from(document.images).every((i) => i.complete);
})()`

// pageHeight is how tall the window must be to show everything: for each
// part of the page that scrolls, how much of it is out of view.
const pageHeight = `(() => {
  let need = Math.max(document.documentElement.scrollHeight, innerHeight);
  let extra = 0;
  for (const el of document.querySelectorAll("*")) {
    const over = el.scrollHeight - el.clientHeight;
    if (over > 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) extra = Math.max(extra, over);
  }
  return need + extra;
})()`

// Limits and waits of a picture.
const (
	pictureMaxHeight = 8000 // a whole page is pictured this tall at most
	pictureMinHeight = 320
	phoneWidth       = 600 // narrower is a phone
	pageLoadWait     = 20 * time.Second
	pageSettleWait   = 12 * time.Second
	pageLookEvery    = 250 * time.Millisecond
	pageFillInWait   = 400 * time.Millisecond // lists that draw only what is in view fill in
)

// pictureRequest is what to take a picture of, and how.
type pictureRequest struct {
	target string // the address to open
	width  int    // CSS pixels
	height int    // CSS pixels
	dark   bool   // the page is told the reader prefers dark
	full   bool   // the whole page, as tall as it is
}

// errNoBrowser is takePicture finding no Chrome or Chromium on the server.
var errNoBrowser = errors.New("no Chrome or Chromium to take pictures with")

// takePicture opens the target in a headless browser at exactly width by
// height CSS pixels and returns a PNG of it. When the whole page was asked
// for it also says how tall the page is: a picture stops at 8000 pixels,
// and the caller is told when the page goes on. It finds the browser
// itself (errNoBrowser when there is none) and runs it with a profile of
// its own, removed afterwards.
func takePicture(ctx context.Context, p pictureRequest) (png []byte, whole int, err error) {
	chrome := findChrome()
	if chrome == "" {
		return nil, 0, errNoBrowser
	}
	dir, err := os.MkdirTemp("", "quadit-render-*")
	if err != nil {
		return nil, 0, err
	}
	defer os.RemoveAll(dir)
	b, err := startBrowser(ctx, chrome, filepath.Join(dir, "profile"))
	if err != nil {
		return nil, 0, err
	}
	defer b.stop()
	devtools := b.cdp
	s, err := openPage(ctx, devtools, p)
	if err != nil {
		return nil, 0, err
	}
	if err := waitForSettledPage(ctx, devtools, s); err != nil {
		return nil, 0, err
	}
	if p.full {
		if whole, err = fitWholePage(ctx, devtools, s, p); err != nil {
			return nil, 0, err
		}
	}
	res, err := devtools.call(ctx, s, "Page.captureScreenshot", map[string]any{"format": "png"})
	if err != nil {
		return nil, 0, err
	}
	var shot struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(res, &shot); err != nil {
		return nil, 0, err
	}
	png, err = base64.StdEncoding.DecodeString(shot.Data)
	if err != nil || len(png) == 0 {
		return nil, 0, errors.New("the browser made no picture")
	}
	_, _ = devtools.call(ctx, "", "Browser.close", map[string]any{}) //nolint:errcheck // the browser is stopped below in any case
	return png, whole, nil
}

// browser is a headless browser running for one picture, and the pipe it
// is driven over.
type browser struct {
	cmd *exec.Cmd
	out *os.File // commands to the browser
	in  *os.File // its answers
	cdp *cdp
}

// startBrowser runs the browser at path chrome, with its profile in the
// folder profile and its debugging pipe, and starts reading what it says.
func startBrowser(ctx context.Context, chrome, profile string) (*browser, error) {
	toBrowser, out, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	in, fromBrowser, err := os.Pipe()
	if err != nil {
		toBrowser.Close()
		out.Close()
		return nil, err
	}
	args := append([]string{"--headless=new", "--remote-debugging-pipe", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
		"--no-default-browser-check", "--user-data-dir=" + profile}, chromeSwitches()...)
	cmd := exec.CommandContext(ctx, chrome, append(args, "about:blank")...)
	cmd.ExtraFiles = []*os.File{toBrowser, fromBrowser} // the browser reads commands on 3 and answers on 4
	err = cmd.Start()
	toBrowser.Close()
	fromBrowser.Close()
	if err != nil {
		out.Close()
		in.Close()
		return nil, err
	}
	b := &browser{cmd: cmd, out: out, in: in, cdp: &cdp{out: out, in: make(chan cdpMsg, 64)}}
	go b.readAnswers(ctx)
	return b, nil
}

// readAnswers passes each message the browser sends to the cdp, until the
// pipe closes or ctx ends. A message that does not read is skipped.
func (b *browser) readAnswers(ctx context.Context) {
	defer close(b.cdp.in)
	r := bufio.NewReaderSize(b.in, 1<<16)
	for {
		raw, err := r.ReadBytes(0)
		if err != nil {
			return
		}
		var m cdpMsg
		if json.Unmarshal(raw[:len(raw)-1], &m) != nil {
			continue
		}
		select {
		case b.cdp.in <- m:
		case <-ctx.Done():
			return
		}
	}
}

// stop ends the browser and closes the pipe.
func (b *browser) stop() {
	b.out.Close()
	_ = b.cmd.Process.Kill() //nolint:errcheck // it may have exited already; either way it is gone
	_ = b.cmd.Wait()         //nolint:errcheck // it was killed: its exit says nothing
	b.in.Close()
}

// openPage opens a tab with the device and color scheme asked for,
// goes to the target and waits for it to load. It returns the tab's
// session.
func openPage(ctx context.Context, devtools *cdp, p pictureRequest) (string, error) {
	res, err := devtools.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"})
	if err != nil {
		return "", err
	}
	var made struct {
		TargetID string `json:"targetId"`
	}
	if err := json.Unmarshal(res, &made); err != nil {
		return "", fmt.Errorf("the browser's answer to opening a tab: %w", err)
	}
	res, err = devtools.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": made.TargetID, "flatten": true})
	if err != nil {
		return "", err
	}
	var at struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(res, &at); err != nil {
		return "", fmt.Errorf("the browser's answer to attaching to the tab: %w", err)
	}
	s := at.SessionID
	phone := p.width < phoneWidth
	if _, err := devtools.call(ctx, s, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": p.width, "height": p.height, "deviceScaleFactor": 1, "mobile": phone}); err != nil {
		return "", err
	}
	if phone {
		_, _ = devtools.call(ctx, s, "Emulation.setTouchEmulationEnabled", map[string]any{"enabled": true}) //nolint:errcheck // without touch the page is still a phone's
	}
	scheme := "light"
	if p.dark {
		scheme = "dark"
	}
	_, _ = devtools.call(ctx, s, "Emulation.setEmulatedMedia", map[string]any{ //nolint:errcheck // without it the page shows in its default scheme
		"features": []map[string]string{{"name": "prefers-color-scheme", "value": scheme}}})
	if _, err := devtools.call(ctx, s, "Page.enable", map[string]any{}); err != nil {
		return "", err
	}
	res, err = devtools.call(ctx, s, "Page.navigate", map[string]any{"url": p.target})
	if err != nil {
		return "", err
	}
	var nav struct {
		ErrorText string `json:"errorText"`
	}
	if err := json.Unmarshal(res, &nav); err != nil {
		return "", fmt.Errorf("the browser's answer to opening the page: %w", err)
	}
	if nav.ErrorText != "" {
		return "", fmt.Errorf("the page did not open: %s", nav.ErrorText)
	}
	devtools.event(ctx, pageLoadWait, func(m cdpMsg) bool { return m.Method == "Page.loadEventFired" })
	return s, nil
}

// waitForSettledPage waits for the page to have its data, then for two
// looks in a row that agree, so a list that is still filling in is not
// caught half-way. A page that does not settle in time is pictured as it is.
func waitForSettledPage(ctx context.Context, devtools *cdp, s string) error {
	settled := 0
	for deadline := time.Now().Add(pageSettleWait); time.Now().Before(deadline) && settled < 2; {
		if devtools.evalTrue(ctx, s, pageSettled) {
			settled++
		} else {
			settled = 0
		}
		select {
		case <-time.After(pageLookEvery):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// fitWholePage makes the window as tall as the page's longest scrolling
// part needs, within reason, and no taller, and returns how tall the page
// is. A page whose height cannot be read is pictured at the size asked.
func fitWholePage(ctx context.Context, devtools *cdp, s string, p pictureRequest) (int, error) {
	res, err := devtools.call(ctx, s, "Runtime.evaluate", map[string]any{"expression": pageHeight, "returnByValue": true})
	var out struct {
		Result struct {
			Value float64 `json:"value"`
		} `json:"result"`
	}
	if err != nil || json.Unmarshal(res, &out) != nil || out.Result.Value <= 0 {
		return 0, nil //nolint:nilerr // the height is a nicety: without it the picture is the size asked
	}
	whole := int(out.Result.Value) + 1
	height := min(max(whole, pictureMinHeight), pictureMaxHeight)
	if _, err := devtools.call(ctx, s, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": p.width, "height": height, "deviceScaleFactor": 1, "mobile": p.width < phoneWidth}); err != nil {
		return 0, err
	}
	select {
	case <-time.After(pageFillInWait):
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	return whole, nil
}
