# FreeTube 0.25.3 custom Intel Mac build

Based on the upstream `v0.25.3-beta` release. This is an unofficial personal fork.

## Changes

- Ignore obsolete search and pagination responses after changing queries/filters or leaving the page.
- Serialize load-more requests and consume exhausted continuation tokens.
- Replace complete session-cache snapshots, including cleared tokens and changed backend metadata.
- Cache search results for at most 60 seconds, separated by preferred backend and safety mode.
- Add a Refresh results button that bypasses the session cache, persistent empty/error/loading messages, and retry.
- Deduplicate result entities while preserving different result types.
- Bound initial backend fallback to one attempt; pagination errors preserve results and retry the same backend/token.
- Add an optional, persisted **Settings → Player Settings → Prefer H.264 video (Intel Macs)** switch. Default is off. Reopen a video to apply it. It requests H.264 preference for DASH playback; unavailable H.264 streams can fall back to other codecs. It does not transcode, manufacture 1440p H.264 streams, or guarantee hardware decoding.

YouTube still controls which search results it returns. These changes do not guarantee that every new upload will appear, and do not add an unsupported newest-first API filter. Refreshing requests new server results without silently changing the selected filters.

## Build and download

The **Custom Intel Mac build** workflow runs on pushes to `umair/search-h264` and can be run manually. Fork Actions may need to be enabled in GitHub first. It installs locked dependencies, runs regression tests and application lint, builds an x86_64 app, checks declared macOS minimum versions, and uploads DMG/ZIP files as an Actions artifact. The artifact expires after 14 days. A successful build is required before an installable artifact is available.

The app is ad-hoc signed using upstream packaging, not Apple notarized. Keep the official app available while trying this build. Close it before opening the custom build; the app name and local profile location are unchanged.

## Verification

Run `node --test tests/search-regressions.test.cjs` with Node 24. These dependency-free tests evaluate the actual search script and cache mutation with mocked Vue/backend APIs, including delayed responses, failures, cache restore, filter forwarding, pagination retries, and codec configuration. They do not mount/render Vue or contact YouTube.

The workflow also runs `pnpm run lint` and `pnpm run build` on macOS. Minimum-version metadata checks are not a substitute for launching on Monterey. Live search, rendering, hardware decoding and smooth playback must still be checked on the target Mac.
