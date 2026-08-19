# Pigeon TestFlight workflow

Pigeon has a manual GitHub Actions workflow at `.github/workflows/release-testflight.yml`. It runs on the repository-scoped Apple Silicon Mac runner labeled `pigeon-ci`; it does not use GitHub-hosted macOS minutes and it never uploads automatically after a push or merge.

Each run checks out trusted `main`, runs the Worker tests and TypeScript check, regenerates the iOS project with XcodeGen, runs the Swift tests on an available iPhone simulator, archives the universal iPhone/iPad app, and uploads it to TestFlight. The first release should leave `internal_only` enabled.

## Apple setup

Create or confirm these Apple resources before the first run:

- App Store Connect app (current external record): `Pigeon Reader` — the app now displays as `Pigeon`; rename the App Store Connect record separately when authorized.
- Explicit App ID: `com.hans.pigeon.reader`
- Embedded WidgetKit App ID: `com.hans.pigeon.reader.widgets`
- Embedded Share Extension App ID: `com.hans.pigeon.reader.share`
- App Group capability: `group.com.hans.pigeon.reader` on all three App IDs
- An Apple Distribution certificate with its private key, exported as a password-protected `.p12`
- App Store Connect provisioning profiles for all three App IDs, created with that distribution certificate and including the App Group capability
- An App Store Connect team API key with permission to upload builds and read/manage TestFlight builds, beta groups, and testers

The profile must be an App Store profile, not a development or Ad Hoc profile. If app capabilities change later, regenerate the profile before releasing.

## GitHub environment and secrets

Create a GitHub environment named `testflight`. Optional required reviewers provide an extra approval before the signing credentials become available.

Add these Actions secrets to the repository or the `testflight` environment:

- `APPLE_TEAM_ID`: Apple Developer team identifier
- `APP_STORE_CONNECT_KEY_ID`: App Store Connect API key identifier
- `APP_STORE_CONNECT_ISSUER_ID`: App Store Connect API issuer identifier
- `APP_STORE_CONNECT_PRIVATE_KEY`: complete contents of the downloaded `.p8` API key
- `BUILD_CERTIFICATE_BASE64`: base64-encoded Apple Distribution `.p12`
- `P12_PASSWORD`: password used when exporting the `.p12`
- `APP_PROVISION_PROFILE_BASE64`: base64-encoded App Store provisioning profile for `com.hans.pigeon.reader` with the App Group capability
- `APP_PROVISION_PROFILE_WIDGETS_BASE64`: base64-encoded App Store provisioning profile for `com.hans.pigeon.reader.widgets` with the App Group capability
- `APP_PROVISION_PROFILE_SHARE_BASE64`: base64-encoded App Store provisioning profile for `com.hans.pigeon.reader.share` with the App Group capability

Example secret-loading commands, run from a trusted Mac without printing the credential contents:

```bash
gh secret set APPLE_TEAM_ID
gh secret set APP_STORE_CONNECT_KEY_ID
gh secret set APP_STORE_CONNECT_ISSUER_ID
gh secret set P12_PASSWORD
gh secret set APP_STORE_CONNECT_PRIVATE_KEY < AuthKey_EXAMPLE.p8
base64 < PigeonDistribution.p12 | tr -d '\n' | gh secret set BUILD_CERTIFICATE_BASE64
base64 < PigeonReader.mobileprovision | tr -d '\n' | gh secret set APP_PROVISION_PROFILE_BASE64
base64 < PigeonWidgets.mobileprovision | tr -d '\n' | gh secret set APP_PROVISION_PROFILE_WIDGETS_BASE64
base64 < PigeonShareExtension.mobileprovision | tr -d '\n' | gh secret set APP_PROVISION_PROFILE_SHARE_BASE64
```

## Self-hosted runner

Register a repository-scoped macOS Apple Silicon runner with the custom label `pigeon-ci`, then install it as a service. It needs Xcode 26 or newer, XcodeGen, Node.js, npm, an available iPhone simulator, and enough disk space for an archive. Keep the runner dedicated to this private repository; do not expose it to fork pull requests.

The workflow creates a uniquely named temporary keychain and release directory for each run. It restores the runner's previous keychain search list and any same-UUID provisioning profile, then removes only the signing files installed by that run. It deliberately does not clear the runner's other keychains, profiles, or global package caches.

## Release

From GitHub Actions, select `Release to TestFlight` on `main` and choose `Run workflow`. The optional marketing version overrides the checked-in `1.0`; the build number is generated from the GitHub run number and retry count.

The workflow has two jobs:

1. `upload` runs the tests, archive, export, and exactly one TestFlight upload. It records the marketing version and archive build number as job outputs and removes the temporary keychain, profiles, certificate, private-key file, and release directory in its final cleanup step.
2. `verify` runs only after a successful upload. The repository-owned `scripts/app-store-connect-verify.mjs` creates a short-lived App Store Connect JWT with the existing key, issuer, and private-key secrets; resolves the app by `com.hans.pigeon.reader`; polls the exact workflow-derived build until it is `VALID`; fails immediately for `FAILED` or `INVALID` and clearly on timeout; resolves the exact `Pigeon Internal` group; attaches the build through the official beta-group/build relationship when necessary; verifies that relationship and at least one tester; and writes the app, bundle, version, build, processing, group, and tester evidence to the step summary.

The API verifier retries transient `429` and `5xx` reads, honors `Retry-After` when present, and uses a JWT lifetime below App Store Connect's limit. Relationship attachment is idempotent: after a conflict or ambiguous server response it re-reads the group's builds with bounded backoff and accepts the operation only when the exact build is present. After a successful attach it waits for the same exact relationship to propagate. A group with `hasAccessToAllBuilds` does not receive a duplicate attach request, but it is still polled until the exact build is listed; an absent relationship is never summarized as covered.

If verification fails after the upload job succeeds, rerun only the failed `verify` job. GitHub Actions retains the successful upload job and its outputs, so verification retries do not upload a second build. Do not rerun the entire workflow after an upload has succeeded unless a new build is intentionally authorized. This path uses the App Store Connect API directly; it has no browser login, cookie import, or third-party release service. A successful upload still needs the verification job to finish before it is reported as available to testers.
