package blob

import (
	"context"
	"fmt"
	"os"

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
		creds, err = google.CredentialsFromJSON(ctx, []byte(c.Credentials), "https://www.googleapis.com/auth/devstorage.read_write")
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
