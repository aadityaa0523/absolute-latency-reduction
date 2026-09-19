param(
  [Parameter(Mandatory)][string]$Region,
  [string]$Profile = 'hackathon',
  [int]$ReservedConcurrency = -1
)
# Packages the relay, uploads it to a per-region code bucket, and deploys the stack. Prints the public URL.
$ErrorActionPreference = 'Stop'
$aws = 'C:\Users\Aadityaa\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe'
if (-not (Test-Path $aws)) { $aws = 'aws' }
$common = @('--region', $Region, '--profile', $Profile)

node scripts/package.js
$account = & $aws sts get-caller-identity @common --query Account --output text
$bucket = "alr-code-$account-$Region"
$key = "relay-$((Get-FileHash build/relay.zip -Algorithm SHA256).Hash.Substring(0, 12).ToLower()).zip"

& $aws s3api head-bucket --bucket $bucket @common 2>$null
if ($LASTEXITCODE -ne 0) {
  if ($Region -eq 'us-east-1') { & $aws s3api create-bucket --bucket $bucket @common }
  else { & $aws s3api create-bucket --bucket $bucket --create-bucket-configuration "LocationConstraint=$Region" @common }
  & $aws s3api put-public-access-block --bucket $bucket --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true @common
}
& $aws s3 cp build/relay.zip "s3://$bucket/$key" @common

& $aws cloudformation deploy --stack-name alr-relay --template-file template.yaml --capabilities CAPABILITY_IAM @common `
  --parameter-overrides "CodeBucket=$bucket" "CodeKey=$key" "ReservedConcurrency=$ReservedConcurrency"
& $aws cloudformation describe-stacks --stack-name alr-relay @common --query "Stacks[0].Outputs[?OutputKey=='RelayUrl'].OutputValue" --output text
