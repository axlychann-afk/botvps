# Bot jual VPS NAT (fixed)

1. Salin `.env.example` menjadi `.env`, isi `BOT_TOKEN` dan `QRIS_TOKEN` baru.
   - `QRIS_STATUS_URL` default sudah benar: `https://qris.zakki.store/cektopup` (GET `?idtopup=...`).
   - Kalau pakai gateway lain, isi URL custom yang menerima `POST` JSON `{ "token", "reference" }`.
2. Salin `data/vps_stock.example.json` menjadi `data/vps_stock.json`, isi stok. Satu pembelian mengambil dua data.
3. Jalankan `npm install`, lalu `npm start`.

Catatan fix:
- Support respons asli zakki.store: `data.qris_image` + `data.id_transaksi` (kode lama cuma cari `qr_url`/`reference` jadi selalu gagal).
- Cek pembayaran pakai `GET /cektopup?idtopup=...`, kenal status `PENDING` vs `SUCCESS`. `404` = belum bayar.
- Tampilkan total bayar asli (nominal + kode unik), batas expired dari API, dan QR sebagai foto.
- Auto-cek tiap `PAYMENT_POLL_SECONDS` + tombol manual "Cek pembayaran".
- Path data pakai `node:path` biar aman di Windows/Linux.
- Typo `PS Berhasil` -> `VPS Berhasil Dibuat`, tambah graceful stop.

Jangan unggah `.env` atau `data/vps_stock.json` ke GitHub. Kalau `.env` sempat ke-push, revoke token di BotFather dan hapus dari git history.
