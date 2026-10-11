# WRS GEMPA — Website & PWA

Website pemantauan gempa Indonesia dan global. Source Android native terpisah tersedia di https://github.com/ilham8171/wrs-gempa-app; APK menggunakan website/API yang sama untuk data peta dan notifikasi latar belakang.

## Data sources

- BMKG public feeds are preferred for official Indonesian earthquake reports.
- InaTEWS feeds provide additional Indonesian earthquake and tsunami-warning context.
- USGS global feed supplements larger global events.
- A separate USGS query covers Indonesia (approximately 94–141.5°E, 11°S–6.5°N) for M2+ events during the last seven days, so events may still appear if BMKG's public feed is unavailable or incomplete.
- USGS ShakeMap products are attached when available. For a BMKG event without a ShakeMap, a USGS map is used only when time, magnitude, and coordinates are sufficiently close. A USGS ShakeMap is not guaranteed for every event and is not an official BMKG intensity assessment.

## Hosting and push notifications

The live site is hosted on Cloudflare Pages. Pages Functions live under `functions/api/`; browser push subscriptions are stored in the Cloudflare KV namespace bound as `PUSH_SUBSCRIPTIONS`. Do not rely on the old Netlify Functions as the active backend.

- `GET /api/earthquakes` — combines BMKG, InaTEWS, and USGS data.
- `GET /api/push-key` — creates/returns the VAPID public key; its private JWK remains in server-side KV and is never returned to clients.
- `POST /api/subscribe` — stores a browser push subscription.
- `DELETE /api/subscribe` — removes a browser push subscription.
- `workers/push-cron.js` — Cloudflare Worker scheduled every minute; sends Web Push for recent qualifying earthquakes and active tsunami warnings.

The Pages project needs the `PUSH_SUBSCRIPTIONS` KV binding in both Preview and Production. The scheduled Worker needs the same namespace binding and an active cron trigger. The Worker checks for new events and deduplicates deliveries per subscription.

## Validation and safety

- JavaScript syntax checks should pass before merging.
- Confirm the Cloudflare Pages preview deployment and test `/api/earthquakes`, `/api/push-key`, and a real browser push subscription before treating notifications as fully verified.
- Push delivery depends on the browser/device allowing notifications and the push provider being reachable. It is not guaranteed to be instant.
- ShakeMap coverage is conditional; missing maps should be presented as unavailable rather than fabricated.
- WRS GEMPA is a supplementary monitor, not a replacement for official BMKG/InaTEWS instructions. In an emergency, follow official alerts and local authorities.

## Android

The Android WebView opens the hosted website, while WorkManager polls `/api/earthquakes` for background alerts. WorkManager scheduling is controlled by Android and is not guaranteed to run at exact intervals.
