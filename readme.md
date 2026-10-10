# WRS GEMPA — Website + Android source

This repository contains the WRS GEMPA website (Netlify static site + functions) at the repository root and the Android app source in `android/`.

## Build the APK
1. Open **Actions** in GitHub.
2. Select **Build WRS GEMPA APK**.
3. Tap **Run workflow** and run it on `main` (or push a change under `android/`).
4. When the run completes successfully, open the run and download the `wrs-gempa-debug-apk` artifact.

The workflow runs unit tests and assembles a debug APK. A successful build proves compilation, not that all notifications work on every device. Background WorkManager polling is subject to Android scheduling and is not instantaneous. Firebase Cloud Messaging also requires the matching Firebase project/server sender to be configured and actively sending messages to the `wrs-gempa-alerts` topic.

## Website deployment
The root includes `netlify.toml` and `netlify/functions`. To deploy automatically, connect this repository to the existing Netlify site and keep the publish directory at `.` with functions directory `netlify/functions`. Do not commit VAPID private keys or other server secrets; set them in Netlify environment variables.

## Important
- `android/app/google-services.json` is the Firebase client configuration for the current Android project. FCM delivery depends on a matching Firebase project and backend sender.
- This is a debug APK workflow, not a Play Store release/signing workflow.
- Earthquake and tsunami safety notices must be confirmed with official BMKG sources; this app is not a replacement for official warnings.
