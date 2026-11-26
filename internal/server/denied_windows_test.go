package server_test

import (
	"sync"
	"testing"

	"golang.org/x/sys/windows"
)

// denyWriting keeps the person running the test from adding anything to
// the folder dir, until the test ends or allow is called. On Windows a
// file mode does not do it: an entry denying it is put in the folder's
// access list.
func denyWriting(t *testing.T, dir string) (allow func()) {
	t.Helper()
	// On a folder these are the rights to add a file and to add a folder.
	return denyUntil(t, dir, windows.FILE_WRITE_DATA|windows.FILE_APPEND_DATA)
}

// denyReading keeps the person running the test from listing what the
// folder dir holds, until the test ends or allow is called.
func denyReading(t *testing.T, dir string) (allow func()) {
	t.Helper()
	return denyUntil(t, dir, windows.FILE_LIST_DIRECTORY)
}

// denyUntil denies the person running the test the rights on dir until the
// test ends or allow is called, then gives dir back the access list it had.
func denyUntil(t *testing.T, dir string, rights windows.ACCESS_MASK) (allow func()) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	had, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	hadList, _, err := had.DACL()
	if err != nil {
		t.Fatal(err)
	}
	denied, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{AccessPermissions: rights, AccessMode: windows.DENY_ACCESS, Inheritance: windows.NO_INHERITANCE,
		Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeValue: windows.TrusteeValueFromSID(user.User.Sid)}}}, hadList)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, denied, nil); err != nil {
		t.Fatal(err)
	}
	allow = sync.OnceFunc(func() {
		if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, hadList, nil); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(allow) // so the test's folder can be removed
	return allow
}
