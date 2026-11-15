// Google Cloud Storage: opening a bucket and signing in to Google.

package blob

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"

	gcblob "gocloud.dev/blob"
	"gocloud.dev/blob/gcsblob"
	"gocloud.dev/gcp"
	"golang.org/x/oauth2/google"
)

// openGCS opens a bucket in Google Cloud Storage.
func openGCS(ctx context.Context, c Config) (*gcblob.Bucket, error) {
	if err := c.need("a bucket", c.Bucket); err != nil {
		return nil, err
	}
	client, err := gcsClient(ctx, c)
	if err != nil {
		return nil, err
	}
	b, err := gcsblob.OpenBucket(ctx, client, c.Bucket, nil)
	if err != nil {
		return nil, fmt.Errorf("file storage: %w", err)
	}
	return b, nil
}

// gcsClient signs in to Google: with the service account key in the
// Config, or else with the machine's identity.
func gcsClient(ctx context.Context, c Config) (*gcp.HTTPClient, error) {
	if c.Credentials == "" && os.Getenv("STORAGE_EMULATOR_HOST") != "" {
		// A local stand-in for Google Cloud Storage takes no sign-in.
		return gcp.NewAnonymousHTTPClient(gcp.DefaultTransport()), nil
	}
	var creds *google.Credentials
	var err error
	if c.Credentials != "" {
		creds, err = gcsCredentials(ctx, []byte(c.Credentials))
	} else {
		creds, err = gcp.DefaultCredentials(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("file storage: Google credentials: %w", err)
	}
	client, err := gcp.NewHTTPClient(gcp.DefaultTransport(), gcp.CredentialsTokenSource(creds))
	if err != nil {
		return nil, fmt.Errorf("file storage: %w", err)
	}
	return client, nil
}

// gcsScope is the access the file store asks Google for.
const gcsScope = "https://www.googleapis.com/auth/devstorage.read_write"

// gcsCredentialTypes are the kinds of Google credentials a key in the
// settings may be: every kind of credentials file Google's library reads,
// as its deprecated CredentialsFromJSON took them. That includes an OAuth
// client file, which has no type.
var gcsCredentialTypes = []google.CredentialsType{
	"", // an OAuth client file ("installed" or "web")
	google.ServiceAccount,
	google.AuthorizedUser,
	google.ExternalAccount,
	google.ExternalAccountAuthorizedUser,
	google.ImpersonatedServiceAccount,
	google.GDCHServiceAccount,
}

// gcsCredentials reads the key in the settings. The library reads a key
// only as the type its caller names, so the type the key says it is must
// be one of the kinds the store takes.
func gcsCredentials(ctx context.Context, key []byte) (*google.Credentials, error) {
	var head struct {
		Type google.CredentialsType `json:"type"`
	}
	if err := json.Unmarshal(key, &head); err != nil {
		return nil, err
	}
	if !slices.Contains(gcsCredentialTypes, head.Type) {
		return nil, fmt.Errorf("unknown credential type %q; a service account key is usual", head.Type)
	}
	return google.CredentialsFromJSONWithType(ctx, key, head.Type, gcsScope)
}
