package cli

import "golang.org/x/sys/windows"

// connectionRefused is the error of a connection nothing listens for:
// Windows has its own number for it, which syscall.ECONNREFUSED is not.
const connectionRefused = windows.WSAECONNREFUSED
