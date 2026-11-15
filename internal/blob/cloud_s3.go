package blob

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	gcblob "gocloud.dev/blob"
	"gocloud.dev/blob/s3blob"
)

// openS3 opens a bucket in AWS S3 or anything else that speaks S3. Without
// an access key it signs in the way the AWS tools do on this machine.
func openS3(ctx context.Context, c Config) (*gcblob.Bucket, error) {
	if err := c.need("a bucket", c.Bucket); err != nil {
		return nil, err
	}
	opts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(orDefault(c.Region, "auto"))}
	if c.AccessKey != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(c.AccessKey, c.SecretKey, "")))
	}
	ac, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("file storage: %w", err)
	}
	client := s3.NewFromConfig(ac, func(o *s3.Options) {
		if c.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.Endpoint)
			o.UsePathStyle = true // what MinIO and most other S3 look-alikes expect
		}
		if c.PathStyle {
			o.UsePathStyle = true
		}
	})
	b, err := s3blob.OpenBucket(ctx, client, c.Bucket, nil)
	if err != nil {
		return nil, fmt.Errorf("file storage: %w", err)
	}
	return b, nil
}
