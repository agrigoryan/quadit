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
	"time"
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
	b, _ := json.Marshal(cdpMsg{ID: id, Method: method, Params: raw, SessionID: session})
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
	for _, m := range c.events {
		if ok(m) {
			return true
		}
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

// truthy evaluates a JavaScript expression in the page.
func (c *cdp) truthy(ctx context.Context, session, js string) bool {
	res, err := c.call(ctx, session, "Runtime.evaluate", map[string]any{"expression": js, "returnByValue": true})
	if err != nil {
		return false
	}
	var out struct {
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
	}
	_ = json.Unmarshal(res, &out)
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

// takePicture opens target in a headless browser at exactly width by height
// CSS pixels and returns a PNG of it.
func takePicture(ctx context.Context, chrome string, extra []string, profile, target string, width, height int, dark, full bool) (png []byte, pageHeight int, err error) {
	png, pageHeight, err = takePictureOf(ctx, chrome, extra, profile, target, width, height, dark, full)
	return
}

// takePictureOf also says how tall the whole page is when full was asked:
// a picture stops at 8000 pixels, and the caller is told when the page
// goes on.
func takePictureOf(ctx context.Context, chrome string, extra []string, profile, target string, width, height int, dark, full bool) ([]byte, int, error) {
	toBrowser, out, err := os.Pipe()
	if err != nil {
		return nil, 0, err
	}
	in, fromBrowser, err := os.Pipe()
	if err != nil {
		toBrowser.Close()
		out.Close()
		return nil, 0, err
	}
	args := append([]string{"--headless=new", "--remote-debugging-pipe", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
		"--no-default-browser-check", "--user-data-dir=" + profile}, extra...)
	cmd := exec.Command(chrome, append(args, "about:blank")...)
	cmd.ExtraFiles = []*os.File{toBrowser, fromBrowser} // the browser reads commands on 3 and answers on 4
	err = cmd.Start()
	toBrowser.Close()
	fromBrowser.Close()
	if err != nil {
		out.Close()
		in.Close()
		return nil, 0, err
	}
	defer func() {
		out.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		in.Close()
	}()

	c := &cdp{out: out, in: make(chan cdpMsg, 64)}
	go func() {
		defer close(c.in)
		r := bufio.NewReaderSize(in, 1<<16)
		for {
			b, err := r.ReadBytes(0)
			if err != nil {
				return
			}
			var m cdpMsg
			if json.Unmarshal(b[:len(b)-1], &m) != nil {
				continue
			}
			select {
			case c.in <- m:
			case <-ctx.Done():
				return
			}
		}
	}()

	res, err := c.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"})
	if err != nil {
		return nil, 0, err
	}
	var made struct {
		TargetID string `json:"targetId"`
	}
	_ = json.Unmarshal(res, &made)
	res, err = c.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": made.TargetID, "flatten": true})
	if err != nil {
		return nil, 0, err
	}
	var at struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(res, &at)
	s := at.SessionID

	phone := width < 600
	if _, err := c.call(ctx, s, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": width, "height": height, "deviceScaleFactor": 1, "mobile": phone}); err != nil {
		return nil, 0, err
	}
	if phone {
		_, _ = c.call(ctx, s, "Emulation.setTouchEmulationEnabled", map[string]any{"enabled": true})
	}
	scheme := "light"
	if dark {
		scheme = "dark"
	}
	_, _ = c.call(ctx, s, "Emulation.setEmulatedMedia", map[string]any{
		"features": []map[string]string{{"name": "prefers-color-scheme", "value": scheme}}})
	if _, err := c.call(ctx, s, "Page.enable", map[string]any{}); err != nil {
		return nil, 0, err
	}
	res, err = c.call(ctx, s, "Page.navigate", map[string]any{"url": target})
	if err != nil {
		return nil, 0, err
	}
	var nav struct {
		ErrorText string `json:"errorText"`
	}
	_ = json.Unmarshal(res, &nav)
	if nav.ErrorText != "" {
		return nil, 0, fmt.Errorf("the page did not open: %s", nav.ErrorText)
	}
	c.event(ctx, 20*time.Second, func(m cdpMsg) bool { return m.Method == "Page.loadEventFired" })

	// Wait for the page to have its data, then for two looks in a row that
	// agree, so a list that is still filling in is not caught half-way.
	settled := 0
	for deadline := time.Now().Add(12 * time.Second); time.Now().Before(deadline) && settled < 2; {
		if c.truthy(ctx, s, pageSettled) {
			settled++
		} else {
			settled = 0
		}
		select {
		case <-time.After(250 * time.Millisecond):
		case <-ctx.Done():
			return nil, 0, ctx.Err()
		}
	}

	whole := 0
	if full {
		// The whole page: as tall as its longest scrolling part needs,
		// within reason, and no taller.
		res, err := c.call(ctx, s, "Runtime.evaluate", map[string]any{"expression": pageHeight, "returnByValue": true})
		var out struct {
			Result struct {
				Value float64 `json:"value"`
			} `json:"result"`
		}
		if err == nil && json.Unmarshal(res, &out) == nil && out.Result.Value > 0 {
			whole = int(out.Result.Value) + 1
			height = min(max(whole, 320), 8000)
			if _, err := c.call(ctx, s, "Emulation.setDeviceMetricsOverride", map[string]any{
				"width": width, "height": height, "deviceScaleFactor": 1, "mobile": phone}); err != nil {
				return nil, 0, err
			}
			select {
			case <-time.After(400 * time.Millisecond): // lists that draw only what is in view fill in
			case <-ctx.Done():
				return nil, 0, ctx.Err()
			}
		}
	}
	res, err = c.call(ctx, s, "Page.captureScreenshot", map[string]any{"format": "png"})
	if err != nil {
		return nil, 0, err
	}
	var shot struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(res, &shot); err != nil {
		return nil, 0, err
	}
	png, err := base64.StdEncoding.DecodeString(shot.Data)
	if err != nil || len(png) == 0 {
		return nil, 0, errors.New("the browser made no picture")
	}
	_, _ = c.call(ctx, "", "Browser.close", map[string]any{})
	return png, whole, nil
}
