# WRS GEMPA — Checklist finalisasi website/PWA

Website dan backend aktif menggunakan Cloudflare Pages Functions. Source Android native/APK dikelola terpisah di https://github.com/ilham8171/wrs-gempa-app.

## Yang sudah diterapkan
- Feed gempa menggabungkan BMKG, InaTEWS WRS realtime, katalog InaTEWS, dan USGS global/Indonesia dengan label sumber.
- Feed WRS realtime dipisahkan dari katalog historis; katalog tidak disamarkan sebagai data realtime saat feed live gagal.
- Timeout upstream dan retry klien dengan mempertahankan data terakhir saat koneksi terganggu.
- Endpoint API mengembalikan status sumber, waktu fetch, interval refresh, dan error upstream.
- ShakeMap USGS dapat menjadi fallback hanya jika cocok dengan event BMKG; sumber peta ditandai.
- Riwayat buletin tsunami resmi ditampilkan; overlay SSHmax hanya boleh dipasang jika sumber menyediakan URL resmi dan batas geografis eksplisit yang tervalidasi.
- Marker gempa tetap dikelola terpisah dari lapisan tsunami; overlay raster tidak interaktif agar klik marker gempa tetap berfungsi.
- GitHub Actions melakukan pemeriksaan sintaks JavaScript dan smoke test kontrak API produksi setiap 15 menit serta saat perubahan terkait masuk.
- Pemeriksaan produksi terakhir yang tercatat: API OK, refreshSeconds=8, 800 event katalog, 1 event WRS realtime, 30 buletin tsunami, WRS tersambung, tanpa error upstream pada pemeriksaan tersebut. Ini adalah snapshot pada waktu uji, bukan jaminan uptime berkelanjutan.

## Belum boleh diklaim selesai
- **Overlay geografis SSHmax:** feed yang diuji belum membuktikan adanya bounds geografis resmi. Pratinjau produk resmi tersedia di panel, tetapi tidak ditempelkan ke peta sampai georeferensi valid tersedia. Jangan menebak bounds dari episentrum atau ukuran gambar.
- **Uji visual manual:** periksa peta, legenda, klik marker, panel tsunami, dan layout di beberapa ukuran layar HP.
- **Push notification browser:** smoke test API tidak membuktikan subscription dan pengiriman push ke perangkat nyata. Perlu uji permission, subscription, deduplikasi, dan pengiriman.
- **Android native/APK:** build, instalasi, permission, serta notifikasi latar belakang perlu diuji di repositori Android/perangkat nyata. WorkManager mengikuti batasan penjadwalan Android, jadi interval instan tidak dijamin.
- **Konfigurasi produksi:** verifikasi binding KV `PUSH_SUBSCRIPTIONS` pada Pages Preview/Production dan trigger Worker terjadwal tanpa membuka atau menampilkan secret.

## Gate sebelum rilis final
1. Pastikan deployment produksi terbaru dan smoke test tetap hijau.
2. Uji endpoint `/api/earthquakes`, `/api/push-key`, dan alur subscription.
3. Uji peta/legenda, marker klik, panel tsunami, dan mode simulasi di perangkat mobile.
4. Uji push browser dan APK di perangkat nyata, termasuk izin dan keadaan aplikasi di latar belakang.
5. Georeferensikan SSHmax hanya dengan metadata spasial resmi yang tervalidasi.
6. Pastikan tidak ada private key, token, atau kredensial yang masuk ke repositori.

## Keselamatan
WRS GEMPA adalah monitor tambahan, bukan pengganti peringatan atau instruksi resmi BMKG/InaTEWS dan otoritas setempat. Jika ada peringatan resmi, ikuti instruksi otoritas.
