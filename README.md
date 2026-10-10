# WRS GEMPA — Source Website (finalisasi)

Repositori ini menyimpan source website/PWA WRS GEMPA. Proyek Android native dan APK berada di repositori terpisah: https://github.com/ilham8171/wrs-gempa-app

## Status
- [ ] Source website lengkap dimasukkan dan diverifikasi.
- [ ] API gempa dan penanganan kegagalan jaringan diuji.
- [ ] Tampilan peta/legenda pada perangkat mobile diuji.
- [ ] Push notification website diuji dengan konfigurasi Netlify yang benar.
- [ ] Proyek Android dibangun dan APK diuji terpisah.

## Struktur source website yang diharapkan
- index.html, styles.css, app.js
- manifest.json, sw.js, icons/
- netlify.toml
- netlify/functions/earthquakes.js
- netlify/functions/subscribe.js
- netlify/functions/check-quakes-push.js
- netlify/functions/_shared/fetchQuakes.js

## Keamanan
Jangan commit VAPID private key, Firebase service-account JSON, token, atau kredensial. Simpan rahasia di environment variables/Secrets pada layanan yang membutuhkannya.

## Notifikasi dan keselamatan
Berhasil membangun APK tidak membuktikan push notification bekerja saat aplikasi ditutup. Aplikasi harus diuji pada perangkat nyata. Interval WorkManager Android memiliki batas sistem dan tidak menjamin peringatan seketika. Informasi peringatan resmi harus dikonfirmasi melalui BMKG; aplikasi ini bukan pengganti arahan resmi.

## Build APK
Build Android dijalankan melalui GitHub Actions pada repositori Android. Perubahan website di repositori ini tidak otomatis mengubah kode native Android.
