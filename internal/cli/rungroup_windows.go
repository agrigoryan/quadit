//go:build windows

package cli

import (
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ownGroup starts cmd in a console process group of its own, so Ctrl-C in
// the terminal reaches the listener, which ends the command, and not the
// command itself.
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

// killGroup kills cmd's process and every process it started that still
// runs, found through their parents. Windows keeps no group of what a
// process started; a process is taken as a child only when it started
// after its parent, since a process id is used again once its process is
// gone. A process whose parent ended before it is killed is not found.
func killGroup(cmd *exec.Cmd) error {
	children := map[uint32][]uint32{}
	if snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0); err == nil {
		entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
		for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
			children[entry.ParentProcessID] = append(children[entry.ParentProcessID], entry.ProcessID)
		}
		closeHandle(snap)
	}
	seen := map[uint32]bool{}
	var kill func(pid uint32, parentBorn int64)
	kill = func(pid uint32, parentBorn int64) {
		if seen[pid] {
			return
		}
		seen[pid] = true
		process, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		if err != nil {
			return
		}
		defer closeHandle(process)
		var created, exited, kernel, user windows.Filetime
		if windows.GetProcessTimes(process, &created, &exited, &kernel, &user) != nil || created.Nanoseconds() < parentBorn {
			return
		}
		_ = windows.TerminateProcess(process, 1) // one already gone has nothing to end
		for _, child := range children[pid] {
			kill(child, created.Nanoseconds())
		}
	}
	kill(uint32(cmd.Process.Pid), 0)
	return nil
}
