// Package quadit holds what the repository's root gives the program: its
// own license and the third-party notices (THIRD_PARTY_NOTICES, made by
// scripts/notices), which a release ships beside the binary and the server
// shows at /licenses.
package quadit

import _ "embed" // the license files below

// License is Quadit's own license, the MIT License.
//
//go:embed LICENSE
var License string

// ThirdPartyNotices are the licenses of the work of others a release
// contains.
//
//go:embed THIRD_PARTY_NOTICES
var ThirdPartyNotices string
