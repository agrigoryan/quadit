//go:build !unix

package cli

import "os"

// lockFile takes no lock where the system gives none this way (Windows,
// where no Quadit server runs on the computer): a second listen there is
// refused by the server's lease alone.
func lockFile(*os.File) error { return nil }
