# Stand-in for SignPath in a rehearsal of the Windows signing flow (.github/workflows/release.yml, Run workflow
# with "signpath_rehearsal", no tag). It does what the SignPath action leaves behind: every file of the request
# folder, signed, in the output folder (the action extracts the signed artifact there). The signature comes from
# a throwaway self-signed certificate that only this disposable runner trusts, so Windows reports it as Valid,
# as it will for SignPath Foundation's certificate.
#
# Never a release: scripts/package.mjs labels rehearsal builds "-rehearsal" (ORBITDROP_SIGNPATH_REHEARSAL=1),
# scripts/release-assets.mjs refuses them, and the workflow only rehearses runs without a tag.
#
#   pwsh -File scripts/signpath-rehearsal.ps1 -Request <request folder> -Output <signed folder>
param(
  [Parameter(Mandatory = $true)] [string] $Request,
  [Parameter(Mandatory = $true)] [string] $Output
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Only for GitHub runners: this script makes a self-signed certificate trusted machine-wide.' }

$subject = 'CN=OrbitDrop SignPath rehearsal (not a release)'
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $subject } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(2)
  $cer = Join-Path $env:RUNNER_TEMP 'orbitdrop-rehearsal.cer'
  Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
  Write-Output "rehearsal certificate $($cert.Thumbprint) trusted on this runner"
}

New-Item -ItemType Directory -Force -Path $Output | Out-Null
$files = @(Get-ChildItem -File -LiteralPath $Request)
if ($files.Count -eq 0) { throw "nothing to sign in $Request" }
foreach ($file in $files) {
  $target = Join-Path $Output $file.Name
  Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  $result = Set-AuthenticodeSignature -LiteralPath $target -Certificate $cert -HashAlgorithm SHA256
  if ($result.Status -ne 'Valid') { throw "$($file.Name): $($result.Status) $($result.StatusMessage)" }
  Write-Output "signed $($file.Name) ($($result.Status))"
}
