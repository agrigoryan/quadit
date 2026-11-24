//go:build !unix

// Where the system gives neither file locks that end with their process nor
// process groups this way (Windows), no form of `quadit run` works: it could
// not keep two runners or two writers of the registry apart, nor stop a
// program and what it started.

package cli

import (
	"context"
	"errors"
	"os"
	"os/exec"
)

// canServe refuses: see the file's comment.
func canServe() error { return errNoServing }

// errNoServing is what quadit run says where it cannot serve.
var errNoServing = errors.New("quadit run serves agents on macOS and Linux only")

func tryLock(*os.File) error { return errNoServing }

func fileIdentity(string) (string, error) { return "", errNoServing }

func waitLock(*os.File) error { return errNoServing }

func startInGroup(*exec.Cmd) error { return errNoServing }

func signalGroup(int, groupSignal) {}

func groupAlive(int) bool { return false }

func processStart(context.Context, int) (string, error) { return "", errNoServing }

func keepAwake(context.Context, int) func() { return func() {} }
