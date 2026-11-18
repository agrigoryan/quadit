// Command notices writes THIRD_PARTY_NOTICES, the licenses of the work of
// others that a release of Quadit contains: the Go modules compiled into
// the binary, the JavaScript packages bundled into the web app inside it,
// and a note on the programs the Docker image adds. Run it from the
// repository root after the web app's packages are installed:
//
//	go run ./scripts/notices          write THIRD_PARTY_NOTICES
//	go run ./scripts/notices -check   fail when the file is not what it would
//	                                  write, or when a dependency is under the
//	                                  GPL, the LGPL or the AGPL
//
// A Go module's license is told from its license file; an npm package's
// from the license its package.json names, as pnpm reports it.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// output is the file written, at the repository root.
const output = "THIRD_PARTY_NOTICES"

// dependency is one module or package with its license files.
type dependency struct {
	name    string // module path, or npm package name
	version string
	license string // what it is under, as an SPDX expression where known
	texts   []licenseFile
}

// licenseFile is one license, notice or patent file of a dependency.
type licenseFile struct {
	name string
	text string
}

func main() {
	check := flag.Bool("check", false, "fail when "+output+" is out of date or a dependency's license is not allowed")
	flag.Parse()
	if err := run(context.Background(), *check); err != nil {
		fmt.Fprintln(os.Stderr, "notices:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, check bool) error {
	modules, err := goModules(ctx)
	if err != nil {
		return err
	}
	packages, err := webPackages(ctx)
	if err != nil {
		return err
	}
	var refused []string
	for _, d := range append(slices.Clone(modules), packages...) {
		if copyleft(d.license) {
			refused = append(refused, fmt.Sprintf("%s %s is under %s", d.name, d.version, d.license))
		}
		if len(d.texts) == 0 && d.license == "" {
			refused = append(refused, fmt.Sprintf("%s %s has no license file and names no license", d.name, d.version))
		}
	}
	if len(refused) > 0 {
		return errors.New("dependencies Quadit cannot take (see CONTRIBUTING.md, Dependencies):\n  " + strings.Join(refused, "\n  "))
	}
	text := render(modules, packages)
	if !check {
		return os.WriteFile(output, []byte(text), 0o644) //nolint:gosec // a public file in the repository, read by everyone
	}
	was, err := os.ReadFile(output)
	if err != nil {
		return err
	}
	if string(was) != text {
		return errors.New(output + " is out of date: run go run ./scripts/notices, and commit the result")
	}
	return nil
}

// goModules are the modules compiled into the quadit binary for every
// platform a release is built for, and Go itself.
func goModules(ctx context.Context) ([]dependency, error) {
	seen := map[string]dependency{}
	for _, goos := range []string{"linux", "darwin"} {
		cmd := exec.CommandContext(ctx, "go", "list", "-deps", "-tags", "web",
			"-f", "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}", "./cmd/quadit")
		cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH=amd64")
		cmd.Stderr = os.Stderr
		out, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("go list: %w", err)
		}
		for line := range strings.SplitSeq(strings.TrimSpace(string(out)), "\n") {
			path, rest, _ := strings.Cut(line, "\t")
			version, dir, _ := strings.Cut(rest, "\t")
			if _, done := seen[path]; done || path == "" {
				continue
			}
			texts, err := licenseFiles(dir)
			if err != nil {
				return nil, err
			}
			seen[path] = dependency{name: path, version: version, license: licenseOf(texts), texts: texts}
		}
	}
	root, err := exec.CommandContext(ctx, "go", "env", "GOROOT").Output()
	if err != nil {
		return nil, fmt.Errorf("go env GOROOT: %w", err)
	}
	texts, err := licenseFiles(strings.TrimSpace(string(root)))
	if err != nil {
		return nil, err
	}
	// The version of Go is left out: it changes with the toolchain that
	// builds the release, and the license does not.
	out := []dependency{{name: "The Go standard library", license: licenseOf(texts), texts: texts}}
	for _, path := range slices.Sorted(maps.Keys(seen)) {
		out = append(out, seen[path])
	}
	return out, nil
}

// webPackages are the packages the web app depends on in production, and
// so may bundle, as pnpm lists them.
func webPackages(ctx context.Context) ([]dependency, error) {
	cmd := exec.CommandContext(ctx, "pnpm", "licenses", "list", "--prod", "--json")
	cmd.Dir = "web"
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("pnpm licenses list (are the web app's packages installed?): %w", err)
	}
	var byLicense map[string][]struct {
		Name     string   `json:"name"`
		Versions []string `json:"versions"`
		Paths    []string `json:"paths"`
	}
	if err := json.Unmarshal(out, &byLicense); err != nil {
		return nil, fmt.Errorf("pnpm licenses list: %w", err)
	}
	var list []dependency
	for license, packages := range byLicense {
		for _, p := range packages {
			for i, version := range p.Versions {
				var texts []licenseFile
				if i < len(p.Paths) {
					if native, err := forOnePlatform(p.Paths[i]); err != nil || native {
						if err != nil {
							return nil, err
						}
						continue
					}
					if texts, err = licenseFiles(p.Paths[i]); err != nil {
						return nil, err
					}
				}
				list = append(list, dependency{name: p.Name, version: version, license: license, texts: texts})
			}
		}
	}
	slices.SortFunc(list, func(a, b dependency) int {
		return strings.Compare(a.name+"@"+a.version, b.name+"@"+b.version)
	})
	return list, nil
}

// forOnePlatform tells whether the package in dir is built for one
// operating system or processor (its package.json names os or cpu): a
// native program some tool runs, never bundled into a web page, and
// installed differently on each machine.
func forOnePlatform(dir string) (bool, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false, err
	}
	var manifest struct {
		OS  []string `json:"os"`
		CPU []string `json:"cpu"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return false, fmt.Errorf("%s: %w", dir, err)
	}
	return len(manifest.OS) > 0 || len(manifest.CPU) > 0, nil
}

// licenseName matches the files that carry a license, a notice or a patent
// grant: LICENSE, LICENSE.md, COPYING, NOTICE.txt, PATENTS, LICENSE-MIT…
var licenseName = regexp.MustCompile(`(?i)^(licen[cs]e|copying|notice|patents)([.-].*)?$`)

// licenseFiles reads the license files at the top of a folder, by name.
func licenseFiles(dir string) ([]licenseFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []licenseFile
	for _, e := range entries {
		if e.IsDir() || !licenseName.MatchString(e.Name()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		out = append(out, licenseFile{name: e.Name(), text: strings.TrimSpace(strings.ReplaceAll(string(raw), "\r\n", "\n"))})
	}
	return out, nil
}

// markers tell a license by words its text always has, most specific
// first. The GNU licenses are told by their titles, which are in capitals:
// other licenses (the MPL among them) name the GPL in ordinary case.
var markers = []struct{ words, license string }{
	{"GNU AFFERO GENERAL PUBLIC LICENSE", "AGPL"},
	{"GNU LESSER GENERAL PUBLIC LICENSE", "LGPL"},
	{"GNU LIBRARY GENERAL PUBLIC LICENSE", "LGPL"},
	{"GNU GENERAL PUBLIC LICENSE", "GPL"},
	{"Mozilla Public License", "MPL-2.0"},
	{"Apache License", "Apache-2.0"},
	{"Permission is hereby granted, free of charge", "MIT"},
	{"Neither the name", "BSD-3-Clause"},
	{"Redistribution and use in source and binary forms", "BSD-2-Clause"},
	{"Permission to use, copy, modify, and/or distribute", "ISC"},
	{"Permission to use, copy, modify, and distribute", "ISC"},
	{"SIL OPEN FONT LICENSE", "OFL-1.1"},
	{"CC0", "CC0-1.0"},
	{"This is free and unencumbered software released into the public domain", "Unlicense"},
}

// licenseOf names the licenses a dependency's files are, joined with AND;
// "" when none is recognized.
func licenseOf(texts []licenseFile) string {
	var found []string
	for _, f := range texts {
		for _, m := range markers {
			if strings.Contains(f.text, m.words) {
				if !slices.Contains(found, m.license) {
					found = append(found, m.license)
				}
				break
			}
		}
	}
	return strings.Join(found, " AND ")
}

// gnu matches a GNU license's SPDX id: GPL-2.0, LGPL-2.1-or-later, AGPL-3.0…
var gnu = regexp.MustCompile(`\b(A|L)?GPL`)

// copyleft tells whether a license expression leaves no choice but the GPL,
// the LGPL or the AGPL: "MIT OR GPL-3.0" can be taken as MIT, "MIT AND
// GPL-3.0" cannot.
func copyleft(expression string) bool {
	for alternative := range strings.SplitSeq(strings.Trim(expression, "()"), " OR ") {
		if !gnu.MatchString(alternative) {
			return false
		}
	}
	return expression != ""
}

// render writes the notices: what they cover, then each group of
// dependencies with every license text once, under the names that share it.
func render(modules, packages []dependency) string {
	var b bytes.Buffer
	b.WriteString(`THIRD-PARTY NOTICES FOR QUADIT

Quadit itself is under the MIT License (LICENSE). A release of it contains
the work of others, under their own licenses, which follow.

  1. Go modules compiled into the quadit binary
  2. JavaScript packages bundled into the web app inside the binary
  3. Programs the Docker image adds
  4. Fonts of the website
  5. The desktop app, released apart

This file is made by go run ./scripts/notices; do not edit it by hand.

`)
	section(&b, "1. GO MODULES COMPILED INTO THE QUADIT BINARY", modules)
	section(&b, "2. JAVASCRIPT PACKAGES BUNDLED INTO THE WEB APP", packages)
	b.WriteString(`Under the Mozilla Public License 2.0, a file-level copyleft license, are
BlockNote's editor packages (@blocknote/core, @blocknote/react,
@blocknote/mantine) and parts of modernc.org/sqlite. Quadit uses their files
unmodified; their source is at https://github.com/TypeCellOS/BlockNote and
https://gitlab.com/cznic/sqlite, at the versions listed above.

`)
	b.WriteString(rule + `3. PROGRAMS THE DOCKER IMAGE ADDS

The Docker image (ghcr.io/agrigoryan/quadit) is Alpine Linux with the quadit
binary and these programs installed from Alpine's packages: git (GPL-2.0),
FFmpeg (LGPL-2.1-or-later, with parts under GPL-2.0-or-later as Alpine
builds it), Chromium (BSD-3-Clause and others), and the Noto fonts
(OFL-1.1), with what they depend on. They are separate programs that Quadit
runs as processes, never linked into it. The image lists every package it
holds, with its license, in /usr/share/doc/quadit/IMAGE_PACKAGES; their
sources are in Alpine's package tree, https://gitlab.alpinelinux.org/alpine/aports,
at the branch of the image's Alpine release. The archives and the .deb and
.rpm packages contain none of these programs.

` + rule + `4. FONTS OF THE WEBSITE

The website (website/ in the repository; not part of a release) uses IBM
Plex Mono and Newsreader, under the SIL Open Font License 1.1. Their
licenses are beside them, in website/fonts/.

` + rule + `5. THE DESKTOP APP, RELEASED APART

The Quadit desktop app (desktop/ in the repository) is released apart from
the server, on its own desktop-v tags, and none of it is in a release of
the server. It is built on Electron (MIT), which contains Chromium
(BSD-3-Clause and others): their licenses are the LICENSE and
LICENSES.chromium.html of Electron's release at the version
desktop/package.json names, which the Windows and Linux packages carry
beside the app. The app's own code bundles no other package.
`)
	return b.String()
}

const rule = "================================================================================\n"

// section writes one group: a line for each dependency, then each distinct
// license text once, headed by the dependencies that carry it.
func section(b *bytes.Buffer, title string, deps []dependency) {
	b.WriteString(rule + title + "\n\n")
	for _, d := range deps {
		license := d.license
		if license == "" {
			license = "see its license text below"
		}
		fmt.Fprintf(b, "  %s: %s\n", strings.TrimSpace(d.name+" "+d.version), license)
	}
	b.WriteString("\n")
	var order []string
	carriers := map[string][]string{}
	for _, d := range deps {
		for _, f := range d.texts {
			if _, known := carriers[f.text]; !known {
				order = append(order, f.text)
			}
			carriers[f.text] = append(carriers[f.text], strings.TrimSpace(d.name+" "+d.version)+" ("+f.name+")")
		}
	}
	for _, text := range order {
		b.WriteString(strings.Repeat("-", 80) + "\n")
		for _, who := range carriers[text] {
			b.WriteString(who + "\n")
		}
		b.WriteString("\n" + text + "\n\n")
	}
}
