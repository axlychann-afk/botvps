# Bot jual VPS NAT

1. Salin `.env.example` menjadi `.env`, isi token baru.
2. Salin `data/vps_stock.example.json` menjadi `data/vps_stock.json`, isi stok. Satu pembelian mengambil dua data.
3. Isi `QRIS_STATUS_URL` setelah mendapat dokumentasi endpoint cek pembayaran. Endpoint harus menerima `POST` JSON `{ "token", "reference" }` dan mengembalikan status `paid`, `success`, atau `settlement`.
4. Jalankan `npm install`, lalu `npm start`.

Jangan unggah `.env` atau `data/vps_stock.json` ke GitHub. Simpan keduanya di VPS.
