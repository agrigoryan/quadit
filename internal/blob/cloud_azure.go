// Azure Blob Storage: opening a container.

package blob

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	gcblob "gocloud.dev/blob"
	"gocloud.dev/blob/azureblob"
)

// openAzure opens a container in Azure Blob storage with an account key.
func openAzure(ctx context.Context, c Config) (*gcblob.Bucket, error) {
	if err := errors.Join(c.need("a container (bucket)", c.Bucket), c.need("an account", c.Account), c.need("an account key", c.AccountKey)); err != nil {
		return nil, err
	}
	cred, err := azblob.NewSharedKeyCredential(c.Account, c.AccountKey)
	if err != nil {
		return nil, fmt.Errorf("file storage: Azure account key: %w", err)
	}
	endpoint := orDefault(c.Endpoint, "https://"+c.Account+".blob.core.windows.net")
	client, err := container.NewClientWithSharedKeyCredential(strings.TrimRight(endpoint, "/")+"/"+c.Bucket, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("file storage: %w", err)
	}
	b, err := azureblob.OpenBucket(ctx, client, nil)
	if err != nil {
		return nil, fmt.Errorf("file storage: %w", err)
	}
	return b, nil
}
