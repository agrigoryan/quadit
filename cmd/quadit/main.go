// Command quadit is the whole product in one binary: the server with the
// web app inside it, the admin commands, and the command-line client.
package main

import (
	"fmt"
	"os"

	"github.com/agrigoryan/quadit/internal/app"
	"github.com/agrigoryan/quadit/internal/cli"
)

// version is set when a release is built.
var version = "dev"

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "serve":
			os.Exit(app.Serve(args[1:], version))
		case "admin":
			os.Exit(app.Admin(args[1:], version))
		case "version", "--version", "-v":
			fmt.Println("quadit", version)
			return
		}
		if run, ok := app.Commands[args[0]]; ok {
			os.Exit(run(args[1:], version))
		}
	}
	os.Exit(cli.Run(args, os.Stdout, os.Stderr))
}
