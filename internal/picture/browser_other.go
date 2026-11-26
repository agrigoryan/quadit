//go:build !windows

package picture

import (
	"os"
	"os/exec"
	"runtime"
)

// passPipes hands the browser the two ends of its debugging pipe and gives
// the switches that tell it so: it reads commands on its file 3 and answers
// on 4.
func passPipes(cmd *exec.Cmd, toBrowser, fromBrowser *os.File) ([]string, error) {
	cmd.ExtraFiles = []*os.File{toBrowser, fromBrowser}
	return []string{"--remote-debugging-pipe"}, nil
}

// installedBrowsers are where this system keeps a Chrome or Chromium that
// is not on PATH: the applications folder on macOS.
func installedBrowsers() []string {
	if runtime.GOOS == "darwin" {
		return []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"}
	}
	return nil
}
