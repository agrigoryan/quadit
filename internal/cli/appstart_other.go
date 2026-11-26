//go:build !windows

package cli

import "syscall"

// connectionRefused is the error of a connection nothing listens for.
const connectionRefused = syscall.ECONNREFUSED
