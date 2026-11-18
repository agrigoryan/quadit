package main

import "testing"

// TestCopyleftLeavesNoChoice: a dependency is refused only when every
// license it may be taken under is the GPL, the LGPL or the AGPL.
func TestCopyleftLeavesNoChoice(t *testing.T) {
	for expression, want := range map[string]bool{
		"MIT": false, "MPL-2.0": false, "(MIT OR CC0-1.0)": false, "MIT OR GPL-3.0": false, "": false,
		"GPL-2.0": true, "LGPL-2.1-or-later": true, "AGPL-3.0": true, "GPL-3.0 OR AGPL-3.0": true, "MIT AND GPL-3.0": true, "BSD-3-Clause AND LGPL": true,
	} {
		if got := copyleft(expression); got != want {
			t.Errorf("copyleft(%q) = %v, want %v", expression, got, want)
		}
	}
}

// TestLicenseOfReadsTheText: a license file is told by its words; the MPL,
// which names the GPL in its own text, is not taken for it.
func TestLicenseOfReadsTheText(t *testing.T) {
	for text, want := range map[string]string{
		"Permission is hereby granted, free of charge, to any person":                                         "MIT",
		"Mozilla Public License Version 2.0 ... means either the GNU General Public License, Version 2.0":     "MPL-2.0",
		"GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007":                                                 "GPL",
		"GNU LESSER GENERAL PUBLIC LICENSE":                                                                   "LGPL",
		"Redistribution and use in source and binary forms ... Neither the name of Google Inc. nor the names": "BSD-3-Clause",
		"Something else entirely": "",
	} {
		if got := licenseOf([]licenseFile{{name: "LICENSE", text: text}}); got != want {
			t.Errorf("licenseOf(%.40q) = %q, want %q", text, got, want)
		}
	}
}
