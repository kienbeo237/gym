#!/bin/sh
# LocalStack chay script nay khi S3 san sang (init/ready.d).
# Bucket PRIVATE: doc/ghi deu qua presigned URL, khong bao gio public-read.
awslocal s3 mb s3://pt-private
awslocal s3api put-public-access-block --bucket pt-private \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "bucket pt-private san sang (private)"
