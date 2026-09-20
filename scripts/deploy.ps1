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
if ($LASTEXITCODE -ne 0) { throw 'packaging failed' }

$account = ([string](& $aws sts get-caller-identity @common --query Account --output text)).Trim()
if (-not $account) { throw "could not read the account id; is the session still valid?" }
$bucket = "alr-code-$account-$Region"
$key = "relay-$((Get-FileHash build/relay.zip -Algorithm SHA256).Hash.Substring(0, 12).ToLower()).zip"

# list-buckets always succeeds, so existence is tested without redirecting a native command's stderr
# (in PowerShell 5.1 that redirection turns ordinary CLI messages into terminating errors).
$existing = ([string](& $aws s3api list-buckets --profile $Profile --query "Buckets[?Name=='$bucket'].Name" --output text)).Trim()
if (-not $existing) {
  Write-Host "creating code bucket $bucket"
  if ($Region -eq 'us-east-1') { & $aws s3api create-bucket --bucket $bucket @common | Out-Null }
  else { & $aws s3api create-bucket --bucket $bucket --create-bucket-configuration "LocationConstraint=$Region" @common | Out-Null }
  if ($LASTEXITCODE -ne 0) { throw "could not create $bucket" }
  & $aws s3api put-public-access-block --bucket $bucket --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true @common | Out-Null
}

& $aws s3 cp build/relay.zip "s3://$bucket/$key" @common
if ($LASTEXITCODE -ne 0) { throw 'upload failed' }

# The fast tier must be a model this Region can actually reach: Nova Lite is in-Region in us-east-1 and eu-north-1,
# and only available through the APAC geographic profile from Mumbai.
$fast = switch ($Region) { 'us-east-1' { 'nova-lite-inregion' } 'eu-north-1' { 'nova-lite-inregion' } default { 'nova-lite-apac' } }
& $aws cloudformation deploy --stack-name alr-relay --template-file template.yaml --capabilities CAPABILITY_IAM @common `
  --parameter-overrides "CodeBucket=$bucket" "CodeKey=$key" "ReservedConcurrency=$ReservedConcurrency" "TierFast=$fast"
if ($LASTEXITCODE -ne 0) { throw 'stack deploy failed' }

& $aws cloudformation describe-stacks --stack-name alr-relay @common --query "Stacks[0].Outputs[?OutputKey=='RelayUrl'].OutputValue" --output text
