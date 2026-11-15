// Command quadit is the whole product in one binary: the server with the
// web app inside it, the admin commands, and the command-line client.
package main

import (
	"fmt"
	"os"
	"regexp"

	"github.com/agrigoryan/quadit/internal/app"
	"github.com/agrigoryan/quadit/internal/cli"
	"github.com/agrigoryan/quadit/internal/engine"
)

// version is set when a release is built.
var version = "dev"

// main sends serve, admin, version and the commands run on the server's
// machine to app, and everything else to the command-line client.
func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "serve":
			os.Exit(app.Serve(args[1:], version))
		case "admin":
			os.Exit(app.Admin(args[1:], version))
		case "version", "--version", "-v":
			fmt.Println("quadit", version, "(agent surface "+engine.Surface+")")
			return
		}
		if run, ok := app.Commands[args[0]]; ok && !restoresTask(args) {
			os.Exit(run(args[1:], version))
		}
	}
	os.Exit(cli.Run(args, os.Stdout, os.Stderr))
}

// taskKey is the shape of a task key (SVA-12).
var taskKey = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*-[0-9]+$`)

// restoresTask tells the two meanings of "restore" apart. "quadit restore
// FILE" brings an install, a task or a page back from a backup, on the
// server's machine; "quadit restore SVA-12" brings a task back from the
// trash, through the API like any other command. It is the second when the
// one thing named has the shape of a task key and is not a file here.
func restoresTask(args []string) bool {
	if len(args) < 2 || args[0] != "restore" || !taskKey.MatchString(args[1]) {
		return false
	}
	for _, a := range args[2:] {
		if a == "--task" || a == "--doc" || a == "--workspace" || a == "--data" || a == "--db" {
			return false
		}
	}
	_, err := os.Stat(args[1])
	return err != nil
}
