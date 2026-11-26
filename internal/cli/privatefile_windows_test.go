package cli

import (
	"regexp"
	"testing"

	"golang.org/x/sys/windows"
)

// openToOthers lets everyone read the file at path, besides what its access
// list allowed.
func openToOthers(t *testing.T, path string) {
	t.Helper()
	everyone, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{AccessPermissions: windows.GENERIC_READ, AccessMode: windows.GRANT_ACCESS,
		Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeValue: windows.TrusteeValueFromSID(everyone)}}}, dacl)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
}

// readableByOthers reports whether the file's access list lets in anyone
// but the person running the test, SYSTEM and Administrators, or takes
// what its folder lets in.
func readableByOthers(t *testing.T, path string) bool {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return true
	}
	// Each entry of the list in SDDL ends in the account it is for.
	allowed := map[string]bool{"SY": true, "BA": true, user.User.Sid.String(): true}
	for _, entry := range regexp.MustCompile(`\(A;[^)]*;([^;)]+)\)`).FindAllStringSubmatch(sd.String(), -1) {
		if !allowed[entry[1]] {
			return true
		}
	}
	return false
}
