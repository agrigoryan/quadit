// Starting the Quadit app when its server on this computer is not running
// (desktop contract §11, amendment): the server there runs only while the
// app does, so an agent's command would otherwise do nothing with the app
// quit.

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// appLogin is the mark the desktop app puts on a login it makes for the
// server it runs (`quadit login URL TOKEN --app PATH`): the app's own
// executable. Only such a login starts the app.
type appLogin struct {
	Path string `json:"path"`
}

// The app's bundle id on macOS, where it is started by it and not by its path.
const appBundleID = "io.github.agrigoryan.quadit"

// stoppedFile is the file the app keeps beside the logins it makes while
// the person has stopped its server on purpose, from its menu.
const stoppedFile = "server-stopped"

// What the command says of starting the app: on stderr when it did, and as
// one more line of the error when it could not.
const (
	appStarted     = "Quadit was not running; started it."
	appStartedOnce = "Quadit was not running; started it. Run the command again."
	appNotStarted  = "Quadit could not be started: open the Quadit app."
	appSilent      = "Quadit is running but its server does not answer: look at the Quadit menu."
	appStoppedNote = "Quadit's server is stopped: start it from the Quadit menu."
)

// appStarter starts the app in the background, and says whether it is
// running already: on macOS, starting a running app would only bring its
// window forward, without telling it anything. The real one runs the
// system's commands; tests give one of their own.
type appStarter interface {
	running(ctx context.Context) bool
	start(ctx context.Context, app appLogin) error
}

// systemStarter starts the app with the command appCommand gives, never
// through a shell; macOS's commands by their full paths, not found on PATH.
type systemStarter struct{}

// running reports whether the app runs: on macOS, whether the system knows
// an application of its bundle id (lsappinfo, which needs no permission,
// and finds the app wherever its bundle is and whatever it is called). On
// Linux a second start of the app hands its arguments to the first, so it
// is always started.
func (systemStarter) running(ctx context.Context) bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	argv := runningCommand()
	out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).Output() //nolint:gosec // a fixed argument list
	return err == nil && appFound(out)
}

// runningCommand asks macOS for a running application of the app's bundle
// id; appFound reads its answer, which names the application, or is empty.
func runningCommand() []string {
	return []string{"/usr/bin/lsappinfo", "find", "bundleid=" + appBundleID}
}

func appFound(out []byte) bool { return strings.Contains(string(out), "ASN:") }

func (systemStarter) start(ctx context.Context, app appLogin) error {
	argv, err := appCommand(runtime.GOOS, app)
	if err != nil {
		return err
	}
	// Detached from the command's end: the app goes on running after it.
	cmd := exec.CommandContext(context.WithoutCancel(ctx), argv[0], argv[1:]...) //nolint:gosec // the argument list of appCommand: a fixed command, or the app's own path as the app recorded it
	if runtime.GOOS == "darwin" {
		return cmd.Run() // open hands the app to the system and returns; its failure is the app not being there
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release() // the app goes on after the command ends
}

// appCommand is the argument list that starts the app in the background
// on a system: on macOS `open` with the app's bundle id, on Linux the
// app's executable as it recorded its path. Elsewhere no server runs on
// the computer for the app to start.
func appCommand(goos string, app appLogin) ([]string, error) {
	switch goos {
	case "darwin":
		return []string{"/usr/bin/open", "-g", "-j", "-b", appBundleID, "--args", "--background"}, nil
	case "linux":
		if !filepath.IsAbs(app.Path) {
			return nil, fmt.Errorf("the login names no path of the app to start (%q)", app.Path)
		}
		return []string{app.Path, "--background"}, nil
	}
	return nil, fmt.Errorf("no Quadit server runs on a %s computer", goos)
}

// appStart is one run's one chance to start the app: for a login the app
// marked, kept in dir.
type appStart struct {
	login   appLogin
	dir     string // the login file's folder, where stoppedFile is
	starter appStarter
	within  time.Duration // how long the server is waited for once the app starts
	stderr  io.Writer
	tried   bool
	// note is what the one try said when it did not end with the server
	// answering, said again on every later failure of the run (a change
	// sent again after the first try ended).
	note string
}

// appStartWithin is how long the command waits for the server once it
// started the app.
const appStartWithin = 20 * time.Second

// revive starts the app when a request to base was refused at the
// connection because its server is not running: the address is this
// computer's own, the network is not kept from the command, and this run
// has not tried yet. It says whether Quadit now answers there (the request
// is then sent again, when resend says it can be), or the line to add to
// the error.
func (a *appStart) revive(ctx context.Context, client *http.Client, base string, err error, resend bool) (answers bool, note string) {
	if !refused(err) || !onThisComputer(base) || os.Getenv("CODEX_SANDBOX_NETWORK_DISABLED") == "1" {
		return false, ""
	}
	if a.tried {
		return false, a.note
	}
	a.tried = true
	answers, a.note = a.startAndWait(ctx, client, base)
	if answers && !resend {
		// A body that cannot be sent twice (a file going up) is not sent again.
		answers, a.note = false, appStartedOnce
	}
	return answers, a.note
}

// startAndWait starts the app, unless the person stopped its server or it
// runs already, and waits for Quadit to answer at base: the line to say on
// failure, or that it answers.
func (a *appStart) startAndWait(ctx context.Context, client *http.Client, base string) (answers bool, note string) {
	if _, err := os.Stat(filepath.Join(a.dir, stoppedFile)); err == nil {
		return false, appStoppedNote
	}
	// An app that runs already is only waited for: its server may be on its way.
	running := a.starter.running(ctx)
	failed := appSilent
	if !running {
		if err := a.starter.start(ctx, a.login); err != nil {
			return false, appNotStarted
		}
		failed = appNotStarted
	}
	ctx, cancel := context.WithTimeout(ctx, a.within)
	defer cancel()
	for {
		switch isQuadit(ctx, client, base) {
		case quaditAnswers:
			if !running {
				fmt.Fprintln(a.stderr, appStarted)
			}
			return true, ""
		case otherAnswers:
			return false, failed // the request is not sent to whatever took the address
		}
		select {
		case <-ctx.Done():
			return false, failed
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// What answers at an address: nothing yet, Quadit, or something else.
const (
	nothingAnswers = iota
	quaditAnswers
	otherAnswers
)

// isQuadit asks what answers at base: Quadit says its name in
// /api/v1/version, which any other service saying "ok" does not.
func isQuadit(ctx context.Context, client *http.Client, base string) int {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/v1/version", nil)
	if err != nil {
		return otherAnswers
	}
	resp, err := client.Do(req)
	if err != nil {
		return nothingAnswers
	}
	defer resp.Body.Close()
	var v struct{ Name string }
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&v) != nil || v.Name != "quadit" {
		return otherAnswers
	}
	return quaditAnswers
}

// refused reports whether a request failed because nothing listens at the
// address: not a timeout, not a name that does not resolve.
func refused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED)
}

// onThisComputer reports whether a server's address is this computer's
// own: localhost, or a loopback address.
func onThisComputer(base string) bool {
	u, err := url.Parse(base)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
