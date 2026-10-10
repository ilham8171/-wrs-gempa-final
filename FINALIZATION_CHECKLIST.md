# WRS GEMPA — Finalisasi source website

Repositori ini adalah source website/PWA. Source Android dan APK dikelola terpisah di https://github.com/ilham8171/wrs-gempa-app.

## Target finalisasi
- Data gempa terbaru otomatis, refresh manual, status loading/error yang jelas.
- Peta responsif di layar HP dan legenda tetap terlihat.
- Dashboard status peringatan tsunami dan wilayah terdampak, dengan sumber resmi yang jelas.
- Push notification dengan backend Netlify; tidak menganggap APK berhasil build sebagai bukti notifikasi latar belakang berfungsi.
- Suara/getaran mengikuti pengaturan notifikasi Android dan izin perangkat.
- Bagikan informasi gempa sebagai teks/gambar dan simpan gambar jika didukung perangkat.
- Tampilan Android/PWA: navigasi, ikon, layout mobile, aksesibilitas.
- Backend/API: timeout, validasi respons, penanganan error, dan jadwal pemantauan.

## Gate sebelum disebut FINAL
1. Masukkan source website lengkap dan pastikan tidak ada duplikasi file yang membingungkan.
2. Periksa endpoint API, konfigurasi Netlify, dan fallback jaringan.
3. Periksa peta/legenda di viewport mobile.
4. Periksa Web Push: subscription, VAPID environment variables, deduplikasi alert, dan pengiriman tanpa membocorkan secret.
5. Jalankan lint/syntax checks dan build/deploy preview.
6. Uji notifikasi pada perangkat nyata; Android membatasi pekerjaan latar belakang sehingga tidak ada jaminan notifikasi instan di semua kondisi.
7. Bangun APK di repositori Android secara terpisah, lalu uji instalasi, permission, dan notifikasi.

## Keamanan
Jangan commit private keys, Firebase service-account JSON, token, atau kredensial. Gunakan environment variables/Secrets. Jangan mengandalkan aplikasi ini sebagai pengganti peringatan dan instruksi resmi BMKG.

## Status
Dokumen ini mencatat target finalisasi. Source lengkap, seluruh pengujian, deployment final, dan APK final harus diverifikasi secara terpisah sebelum statusnya diklaim selesai.
