package picture

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/windows"
)

// passPipes hands the browser the two ends of its debugging pipe and gives
// the switches that tell it so. Windows has no file numbers to hand on, so
// the browser is given the two handles themselves, read end first, by
// their values (--remote-debugging-io-pipes); only they are inherited.
func passPipes(cmd *exec.Cmd, toBrowser, fromBrowser *os.File) ([]string, error) {
	handles := []syscall.Handle{syscall.Handle(toBrowser.Fd()), syscall.Handle(fromBrowser.Fd())}
	for _, h := range handles {
		if err := windows.SetHandleInformation(windows.Handle(h), windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT); err != nil {
			return nil, err
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{AdditionalInheritedHandles: handles}
	return []string{"--remote-debugging-pipe", fmt.Sprintf("--remote-debugging-io-pipes=%d,%d", handles[0], handles[1])}, nil
}

// installedBrowsers are where Windows keeps Chrome, for everyone or for one
// person, and Edge, which every Windows 10 and 11 has and which is Chromium.
func installedBrowsers() []string {
	var out []string
	for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LocalAppData")} {
		if base != "" {
			out = append(out, filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"))
		}
	}
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles")} {
		if base != "" {
			out = append(out, filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	}
	return out
}
