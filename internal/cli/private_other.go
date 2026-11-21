//go:build !unix

package cli

// loginIsPrivate is false where no Quadit server runs on the computer
// (Windows): the app is never started from there.
func loginIsPrivate(string) bool { return false }
