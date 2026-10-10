# WRS GEMPA — Finalisasi

Repositori ini adalah **source website/PWA**, bukan proyek Android Gradle. Aplikasi Android berada di repositori terpisah: https://github.com/ilham8171/wrs-gempa-app

## Komponen website yang harus masuk ke repositori

- `index.html` — antarmuka
- `styles.css` — tata letak responsif
- `app.js` — interaksi antarmuka
- `manifest.json`, `sw.js`, ikon — PWA
- `netlify.toml` — konfigurasi deploy
- `netlify/functions/earthquakes.js`
- `netlify/functions/subscribe.js`
- `netlify/functions/check-quakes-push.js`
- `netlify/functions/_shared/fetchQuakes.js`

## Checklist sebelum dinyatakan final

- [ ] Pastikan sumber gempa/API aktif dan tangani timeout serta kegagalan jaringan.
- [ ] Pastikan peta, legenda, dan tampilan ponsel berfungsi.
- [ ] Pastikan data tsunami/peringatan hanya ditampilkan berdasarkan sumber resmi; jangan mengarang status peringatan.
- [ ] Uji izin notifikasi, subscription, VAPID, dan fungsi terjadwal Netlify.
- [ ] Jangan menyimpan VAPID private key, token, atau rahasia lain di Git.
- [ ] Uji seluruh endpoint di production dan pantau log deploy.
- [ ] Di proyek Android, periksa Firebase configuration dan izin Android 13+; build sukses saja tidak membuktikan push notification bekerja saat aplikasi tertutup.

## Build APK

APK dibangun dari proyek Android di repositori terpisah melalui GitHub Actions. Perubahan website tidak otomatis mengubah kode native Android. Build dan notifikasi wajib diverifikasi sebelum menyebut rilis final.

## Keamanan

Konfigurasikan rahasia sebagai environment variables di Netlify/GitHub Secrets. Jangan commit file rahasia atau kredensial.