// Starting the Quadit app when its server on this computer is not running
// (desktop contract §11, amendment): the server there runs only while the
// app does, so an agent's command would otherwise do nothing with the app
// quit.

package cli

import (
	"context"
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
	appNotStarted  = "Quadit could not be started: open the Quadit app."
	appSilent      = "Quadit is running but its server does not answer: look at the Quadit menu."
	appStoppedNote = "Quadit's server is stopped: start it from the Quadit menu."
)

// appStarter starts the app in the background, and says whether it is
// running already: on macOS, starting a running app would only bring its
// window forward, without telling it anything. The real one runs the
// system's commands; tests give one of their own.
type appStarter interface {
	running() bool
	start(app appLogin) error
}

// systemStarter starts the app with the command appCommand gives, never
// through a shell.
type systemStarter struct{}

// running reports whether the app runs: on macOS, whether the system knows
// an application of its bundle id (lsappinfo, which needs no permission,
// and finds the app wherever its bundle is and whatever it is called). On
// Linux a second start of the app hands its arguments to the first, so it
// is always started.
func (systemStarter) running() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	argv := runningCommand()
	out, err := exec.Command(argv[0], argv[1:]...).Output() //nolint:gosec // a fixed argument list
	return err == nil && appFound(out)
}

// runningCommand asks macOS for a running application of the app's bundle
// id; appFound reads its answer, which names the application, or is empty.
func runningCommand() []string { return []string{"lsappinfo", "find", "bundleid=" + appBundleID} }

func appFound(out []byte) bool { return strings.Contains(string(out), "ASN:") }

func (systemStarter) start(app appLogin) error {
	argv, err := appCommand(runtime.GOOS, app)
	if err != nil {
		return err
	}
	cmd := exec.Command(argv[0], argv[1:]...) //nolint:gosec // the argument list of appCommand: a fixed command, or the app's own path as the app recorded it
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
		return []string{"open", "-g", "-j", "-b", appBundleID, "--args", "--background"}, nil
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
}

// appStartWithin is how long the command waits for the server once it
// started the app.
const appStartWithin = 20 * time.Second

// revive starts the app when a request to base was refused at the
// connection because its server is not running: the address is this
// computer's own, the network is not kept from the command, and this run
// has not tried yet. It says whether the server now answers (the request
// is then sent again), or the line to add to the error.
func (a *appStart) revive(ctx context.Context, client *http.Client, base string, err error) (answers bool, note string) {
	if a.tried || !refused(err) || !onThisComputer(base) || os.Getenv("CODEX_SANDBOX_NETWORK_DISABLED") == "1" {
		return false, ""
	}
	a.tried = true
	if _, err := os.Stat(filepath.Join(a.dir, stoppedFile)); err == nil {
		return false, appStoppedNote
	}
	// An app that runs already is only waited for: its server may be on its way.
	running := a.starter.running()
	failed := appSilent
	if !running {
		if err := a.starter.start(a.login); err != nil {
			return false, appNotStarted
		}
		failed = appNotStarted
	}
	ctx, cancel := context.WithTimeout(ctx, a.within)
	defer cancel()
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/healthz", nil)
		if err != nil {
			return false, appNotStarted
		}
		if resp, err := client.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if !running {
					fmt.Fprintln(a.stderr, appStarted)
				}
				return true, ""
			}
		}
		select {
		case <-ctx.Done():
			return false, failed
		case <-time.After(250 * time.Millisecond):
		}
	}
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
