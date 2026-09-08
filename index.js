import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, 'data');
const stockFile = path.join(dataDir, 'vps_stock.json');
const stockExampleFile = path.join(dataDir, 'vps_stock.example.json');
const ordersFile = path.join(dataDir, 'orders.json');
const usersFile = path.join(dataDir, 'users.json');

// ---- Validasi env ----
const required = ['BOT_TOKEN', 'QRIS_TOKEN'];
for (const name of required) {
  if (!process.env[name] || String(process.env[name]).includes('ganti_dengan')) {
    throw new Error(`${name} belum diisi di .env (salin dari .env.example lalu isi token asli)`);
  }
}
if (!String(process.env.BOT_TOKEN).includes(':')) {
  throw new Error('BOT_TOKEN tidak valid (format harus 123456:ABCDEF...)');
}

const PRICE = Number(process.env.PRICE || 1000);
const UNIT_PRICE = Math.round(PRICE / 2);

const config = {
  qrisToken: process.env.QRIS_TOKEN,
  // XentraPay: semua endpoint GET pakai ?apikey=... (lihat https://app.xentrapay.xyz/docs)
  // QRIS_TOKEN di .env sekarang = XentraPay apikey (mgcloudpay_...).
  topupUrl: process.env.QRIS_TOPUP_URL || 'https://app.xentrapay.xyz/api/invoice',
  statusUrl: process.env.QRIS_STATUS_URL || 'https://app.xentrapay.xyz/api/invoice/status',
  cancelUrl: process.env.QRIS_CANCEL_URL || '', // XentraPay tak ada cancel API -> batal lokal saja
  pollSeconds: Number(process.env.PAYMENT_POLL_SECONDS || 15),
  timeoutMinutes: Number(process.env.PAYMENT_TIMEOUT_MINUTES || 10),
  // Total kapasitas stok untuk bar persen. Isi mis. 102. Kalau 0/kosong, total = sisa saat ini.
  stockTotal: Number(process.env.STOCK_TOTAL || 0),
  productSpec: process.env.PRODUCT_SPEC || 'NAT | Unlimited',
  adminIds: String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  testiGroupId: process.env.TESTI_GROUP_ID || '',
  shopName: process.env.SHOP_NAME || 'VPS NAT Store',
};

const bot = new Telegraf(process.env.BOT_TOKEN);
let stockLock = Promise.resolve();
const pollTimers = new Map();

// ---- Helpers file ----
async function ensureData() {
  await mkdir(dataDir, { recursive: true });
  try {
    await access(ordersFile, constants.F_OK);
  } catch {
    await writeJson(ordersFile, {});
  }
  try {
    await access(usersFile, constants.F_OK);
  } catch {
    await writeJson(usersFile, {});
  }
  try {
    await access(stockFile, constants.F_OK);
  } catch {
    let hint = 'Buat data/vps_stock.json dari data/vps_stock.example.json';
    try {
      await access(stockExampleFile, constants.F_OK);
      hint += ' (contoh: copy data\\vps_stock.example.json menjadi data\\vps_stock.json di Windows)';
    } catch {}
    throw new Error(hint);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

function withStockLock(fn) {
  const next = stockLock.then(fn, fn);
  stockLock = next.catch(() => {});
  return next;
}

// ---- Helpers QRIS (XentraPay — verified live 2026-09-08) ----
// Create:  GET /api/invoice?apikey=KEY&amount=N
//   -> { success:true, invoice_id, amount, fee, total, qris_image, payment_link, expired_at }
// Status:  GET /api/invoice/status?apikey=KEY&invoice_id=ID
//   -> { invoice_id, amount, fee, total, status:"pending"|"paid"|..., qris_image, ... }
// Cancel:  tak ada endpoint cancel di XentraPay -> batal lokal (stop polling, tandai cancelled).
//   Invoice yang tak dibayar expired sendiri (±15 mnt, lihat expired_at).

function paymentImage(response) {
  return response.qris_image || response.qr_image || response.image || null;
}

function paymentReference(response) {
  return response.invoice_id || null;
}

function paymentTotal(response, fallback = PRICE) {
  return response.total || response.amount || fallback;
}

function paymentNominal(response, fallback) {
  return response.amount || fallback;
}

function paymentExpiredAt(response) {
  return response.expired_at || null;
}

const PAID_STATUSES = new Set([
  'paid', 'success', 'settlement', 'berhasil', 'sukses',
  'lunas', 'done', 'completed', 'complete', 'ok', 'approved', 'settled',
]);

function paid(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.paid === true || response.data?.paid === true) return true;
  const candidates = [
    response.status,
    response.kategori_status,
    response.data?.status,
    response.data?.kategori_status,
  ];
  for (const c of candidates) {
    if (c && PAID_STATUSES.has(String(c).toLowerCase())) return true;
  }
  return false;
}

function vpsMessage(vps, index) {
  return `VPS ${index}\n───────────◆───────────\n\nɪɴꜰᴏʀᴍᴀꜱɪ ᴠᴘꜱ\n🌐 IP       : ${vps.ip}\n🔌 PORT     : ${vps.port}\n👤 USERNAME : ${vps.username || 'root'}\n🔐 PASSWORD : ${vps.password}\n\nꜱꜱʜ ᴀᴋꜱᴇꜱ\nssh ${vps.username || 'root'}@${vps.ip} -p ${vps.port}\n\n🟢 Status   : ${vps.status || 'ACTIVE'}`;
}

function getChatId(ctx) {
  return ctx.chat?.id ?? ctx.from?.id;
}

async function createQris(nominal = PRICE) {
  const url = `${config.topupUrl}${config.topupUrl.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(config.qrisToken)}&amount=${encodeURIComponent(nominal)}`;
  const response = await fetch(url, { method: 'GET' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false)
    throw new Error(body.message || body.error || `QRIS HTTP ${response.status}`);
  const image = paymentImage(body);
  const reference = paymentReference(body);
  if (!image || !reference) {
    throw new Error(
      `Respons invoice tak dikenali (butuh qris_image + invoice_id). Dapat: ${JSON.stringify(body).slice(0, 300)}`
    );
  }
  return {
    image,
    content: null,
    reference,
    total: paymentTotal(body, nominal),
    nominal: paymentNominal(body, nominal),
    expiredAt: paymentExpiredAt(body),
    cancelUrl: null,
    checkUrl: body.payment_link || null,
    paymentLink: body.payment_link || null,
    raw: body,
  };
}

async function checkPayment(order) {
  const reference = order.reference;
  if (!reference) return false;
  const url = `${config.statusUrl}${config.statusUrl.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(config.qrisToken)}&invoice_id=${encodeURIComponent(reference)}`;
  const response = await fetch(url, { method: 'GET' });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return false; // invoice tak ada = belum bayar / salah id
  if (!response.ok) throw new Error(body.message || body.error || `Status QRIS HTTP ${response.status}`);
  return paid(body);
}

// XentraPay tak sediakan cancel API: batal = stop polling + tandai cancelled lokal.
// Invoice pending expired otomatis (±15 mnt). Tak ada dana ketahan karena belum dibayar.
async function cancelPayment(order) {
  return true;
}

// ---- Admin & saldo ----
function isAdmin(ctx) {
  return config.adminIds.includes(String(ctx.from?.id ?? ''));
}

async function notifyAdmins(text) {
  if (!config.adminIds.length) return;
  for (const id of config.adminIds) {
    try {
      await bot.telegram.sendMessage(id, text);
    } catch (e) {
      console.error(`Gagal notif admin ${id} (cek ADMIN_IDS & admin sudah /start bot):`, e.message);
    }
  }
}

async function getBalance(chatId) {
  try {
    const users = await readJson(usersFile);
    return Number(users?.[chatId]?.balance || 0);
  } catch {
    return 0;
  }
}

// ---- Testimoni gambar (dark modern, sharp SVG -> PNG) ----
function escXml(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

let _sharp = undefined;
async function getSharp() {
  if (_sharp !== undefined) return _sharp;
  try {
    const m = await import('sharp');
    _sharp = m.default || m;
  } catch {
    _sharp = null;
  }
  return _sharp;
}

function testiSvg({ title, name, detail, amount, date, ref }) {
  const n = escXml(String(name).slice(0, 24) || 'Pembeli');
  const d = escXml(detail);
  const a = escXml(amount);
  const t = escXml(date);
  const r = escXml(String(ref).slice(0, 24));
  const shop = escXml(config.shopName);
  return `<svg width="800" height="520" viewBox="0 0 800 520" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#1b2a4a"/>
</linearGradient>
<linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#22c55e"/><stop offset="1" stop-color="#22d3ee"/>
</linearGradient>
</defs>
<rect x="8" y="8" width="784" height="504" rx="24" fill="url(#bg)" stroke="#22c55e" stroke-width="3"/>
<rect x="8" y="8" width="784" height="10" rx="5" fill="url(#acc)"/>
<text x="400" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" fill="#fbbf24" letter-spacing="8">★★★★★</text>
<text x="400" y="128" text-anchor="middle" font-family="Arial,sans-serif" font-size="40" font-weight="bold" fill="#ffffff" letter-spacing="2">${title}</text>
<rect x="120" y="150" width="560" height="4" rx="2" fill="url(#acc)"/>
<text x="120" y="205" font-family="Arial,sans-serif" font-size="24" fill="#94a3b8">Nama</text>
<text x="300" y="205" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#ffffff">: ${n}</text>
<text x="120" y="250" font-family="Arial,sans-serif" font-size="24" fill="#94a3b8">Order</text>
<text x="300" y="250" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#22d3ee">: ${d}</text>
<text x="120" y="295" font-family="Arial,sans-serif" font-size="24" fill="#94a3b8">Nominal</text>
<text x="300" y="295" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#22c55e">: ${a}</text>
<text x="120" y="340" font-family="Arial,sans-serif" font-size="24" fill="#94a3b8">Tanggal</text>
<text x="300" y="340" font-family="Arial,sans-serif" font-size="24" fill="#ffffff">: ${t}</text>
<text x="120" y="385" font-family="Arial,sans-serif" font-size="24" fill="#94a3b8">Ref</text>
<text x="300" y="385" font-family="monospace" font-size="22" fill="#94a3b8">: ${r}</text>
<rect x="120" y="415" width="560" height="4" rx="2" fill="url(#acc)"/>
<text x="400" y="455" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#ffffff">${shop}</text>
<text x="400" y="485" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#94a3b8">Terima kasih atas kepercayaan Anda</text>
</svg>`;
}

// kind: 'buy' | 'topup'
async function sendTesti(kind, { name, detail, amount, ref }) {
  if (!config.testiGroupId) return;
  const title = kind === 'topup' ? 'TESTIMONI DEPOSIT' : 'TESTIMONI PEMBELIAN';
  const date = new Date().toLocaleString('id-ID');
  const caption = `✅ ${title}\n👤 ${name}\n📦 ${detail}\n💰 ${amount}\n📅 ${date}`;
  const sharp = await getSharp();
  if (sharp) {
    try {
      const buf = await sharp(Buffer.from(testiSvg({ title, name, detail, amount, date, ref }))).png().toBuffer();
      await bot.telegram.sendPhoto(config.testiGroupId, { source: buf }, { caption });
      return;
    } catch (e) {
      console.error('Gagal bikin gambar testimoni:', e.message);
    }
  }
  // Fallback teks kalau sharp belum diinstall / gagal
  try {
    await bot.telegram.sendMessage(config.testiGroupId, `${caption}\nRef: ${ref}`);
  } catch (e) {
    console.error('Gagal kirim testimoni ke grup (cek TESTI_GROUP_ID & bot sudah masuk grup):', e.message);
  }
}

// Dipanggil tiap pembelian QRIS/saldo sukses: notif admin + testimoni grup.
async function afterBuySuccess(order, vps) {
  try {
    const left = await getStockCount();
    await notifyAdmins(
      `🛒 Penjualan!\n👤 ${order.buyerName || 'User'} (${order.chatId})\n📦 2x VPS NAT via ${order.payMethod === 'balance' ? 'SALDO' : 'QRIS'} ${formatRupiah(order.total || PRICE)}\n🌐 ${vps.map((v) => `${v.ip}:${v.port}`).join(', ')}\n📊 Sisa stok: ${left}\nRef: ${order.reference || String(order.id).slice(0, 8)}`
    );
  } catch {}
  try {
    await sendTesti('buy', {
      name: order.buyerName || 'Pembeli',
      detail: '2x VPS NAT',
      amount: formatRupiah(order.total || PRICE),
      ref: order.reference || order.id,
    });
  } catch {}
}

// User sudah bayar tapi stok habis: admin harus turun tangan manual.
async function handlePaidNoStock(order, via) {
  const msg =
    `🚨 BAYAR TAPI STOK HABIS\n👤 ${order.buyerName || 'User'} (${order.chatId})\n💰 ${formatRupiah(order.total || PRICE)} via ${via}\nRef: ${order.reference || order.id}\nSegera hubungi pembeli (refund / kirim manual)!`;
  await notifyAdmins(msg);
  try {
    await bot.telegram.sendMessage(
      order.chatId,
      `Pembayaran ${formatRupiah(order.total || PRICE)} terdeteksi tapi stok sedang habis.\nJangan khawatir, admin akan menghubungi kamu.\nSimpan reference ini: ${order.reference || order.id}`
    );
  } catch {}
}

function isExpired(order) {
  if (order.expiredAt) {
    const t = Date.parse(order.expiredAt);
    if (!Number.isNaN(t)) return Date.now() > t;
  }
  return Date.now() - order.createdAt > config.timeoutMinutes * 60_000;
}

async function markExpired(orderId) {
  try {
    const orders = await readJson(ordersFile);
    const order = orders[orderId];
    if (order && order.status === 'pending') {
      order.status = 'expired';
      await writeJson(ordersFile, orders);
    }
  } catch {}
}

async function deliver(orderId) {
  const orders = await readJson(ordersFile);
  const order = orders[orderId];
  if (!order || order.status === 'delivered') return false;
  const stock = await readJson(stockFile);
  if (!Array.isArray(stock)) throw new Error('Format data/vps_stock.json harus array.');
  if (stock.length < 2) throw new Error('Stok VPS kurang dari 2.');
  const vps = stock.splice(0, 2);
  await writeJson(stockFile, stock);
  order.status = 'delivered';
  order.deliveredAt = Date.now();
  order.vps = vps;
  await writeJson(ordersFile, orders);
  await bot.telegram.sendMessage(
    order.chatId,
    `VPS Berhasil Dibuat\n───────────◆───────────\n\n${vpsMessage(vps[0], 1)}\n\n───────────◆───────────\n\n${vpsMessage(vps[1], 2)}\n\nSimpan baik-baik. Jangan share ke orang lain.`
  );
  await afterBuySuccess(order, vps);
  return true;
}

// Kredit saldo deposit yang sudah dibayar via QRIS.
async function creditTopup(orderId) {
  const orders = await readJson(ordersFile);
  const order = orders[orderId];
  if (!order || (order.kind && order.kind !== 'topup') || order.status !== 'pending') return false;
  const users = await readJson(usersFile);
  const u = users[order.chatId] || { balance: 0 };
  u.balance = (Number(u.balance) || 0) + Number(order.amount || 0);
  if (order.buyerName) u.name = order.buyerName;
  users[order.chatId] = u;
  order.status = 'credited';
  order.creditedAt = Date.now();
  await writeJson(usersFile, users);
  await writeJson(ordersFile, orders);
  try {
    await bot.telegram.sendMessage(
      order.chatId,
      `✅ Deposit ${formatRupiah(order.amount)} berhasil!\n💰 Saldo kamu sekarang: ${formatRupiah(u.balance)}\nPakai /start untuk beli VPS pakai saldo.`
    );
  } catch {}
  try {
    await notifyAdmins(
      `💰 Deposit!\n👤 ${order.buyerName || 'User'} (${order.chatId})\n💰 ${formatRupiah(order.amount)} (bayar ${formatRupiah(order.total)})\n💳 Saldo sekarang: ${formatRupiah(u.balance)}\nRef: ${order.reference}`
    );
  } catch {}
  try {
    await sendTesti('topup', {
      name: order.buyerName || 'Pembeli',
      detail: 'Deposit Saldo',
      amount: formatRupiah(order.amount),
      ref: order.reference || order.id,
    });
  } catch {}
  return true;
}

async function verifyAndDeliver(ctx, id, { auto = false } = {}) {
  const orders = await readJson(ordersFile);
  const order = orders[id];
  const chatId = getChatId(ctx);
  if (!order || (chatId && order.chatId !== chatId)) {
    if (!auto) await ctx.answerCbQuery('Pesanan tidak ditemukan.');
    return false;
  }
  if (order.status === 'delivered') {
    if (!auto) await ctx.answerCbQuery('Data sudah dikirim.');
    return true;
  }
  if (order.status === 'credited') {
    if (!auto) await ctx.answerCbQuery('Deposit sudah diproses.');
    return true;
  }
  if (order.status === 'cancelled') {
    if (!auto) await ctx.answerCbQuery('Pesanan sudah dibatalkan.');
    return false;
  }
  if (order.status === 'expired' || isExpired(order)) {
    order.status = 'expired';
    await writeJson(ordersFile, orders);
    stopPolling(id);
    if (!auto) await ctx.answerCbQuery('QRIS kedaluwarsa. Buat pesanan baru.');
    else await bot.telegram.sendMessage(order.chatId, 'QRIS kedaluwarsa. Silakan buat pesanan baru dengan /start.').catch(() => {});
    return false;
  }
  let ok = false;
  try {
    ok = await checkPayment(order);
  } catch (e) {
    if (!auto) {
      await ctx.answerCbQuery('Gagal cek pembayaran.');
      await ctx.reply(`Gagal cek: ${e.message}`).catch(() => {});
    }
    return false;
  }
  if (!ok) {
    if (!auto) await ctx.answerCbQuery('Belum ada pembayaran.');
    return false;
  }
  const kind = order.kind || 'buy';
  if (kind === 'topup') {
    const credited = await creditTopup(order.id);
    stopPolling(order.id);
    if (!auto) await ctx.answerCbQuery(credited ? 'Deposit berhasil. Saldo bertambah.' : 'Deposit sudah diproses.');
    return true;
  }
  try {
    const delivered = await withStockLock(() => deliver(order.id));
    stopPolling(order.id);
    if (!auto) await ctx.answerCbQuery(delivered ? 'Pembayaran berhasil. Data dikirim.' : 'Data sudah dikirim.');
    return true;
  } catch (e) {
    if (!auto) {
      await ctx.answerCbQuery('Stok bermasalah.');
      await ctx.reply(`Pembayaran terdeteksi tapi stok gagal: ${e.message}`).catch(() => {});
    } else {
      await bot.telegram.sendMessage(order.chatId, `Pembayaran terdeteksi tapi stok gagal: ${e.message}`).catch(() => {});
    }
    await handlePaidNoStock(order, 'QRIS');
    return false;
  }
}

function stopPolling(orderId) {
  const t = pollTimers.get(orderId);
  if (t) {
    clearInterval(t);
    pollTimers.delete(orderId);
  }
}

// Pengecekan otomatis tanpa ctx (dipakai polling): dukung order beli & deposit.
async function autoCheck(orderId) {
  const orders = await readJson(ordersFile);
  const order = orders[orderId];
  if (!order || order.status !== 'pending') {
    stopPolling(orderId);
    return;
  }
  if (isExpired(order)) {
    order.status = 'expired';
    await writeJson(ordersFile, orders);
    stopPolling(orderId);
    await bot.telegram.sendMessage(order.chatId, 'QRIS kedaluwarsa. Silakan buat pesanan baru dengan /start.').catch(() => {});
    return;
  }
  let ok = false;
  try {
    ok = await checkPayment(order);
  } catch {
    return; // coba lagi di tick berikutnya
  }
  if (!ok) return;
  if ((order.kind || 'buy') === 'topup') {
    await creditTopup(order.id);
    stopPolling(orderId);
    return;
  }
  try {
    await withStockLock(() => deliver(order.id));
    stopPolling(orderId);
  } catch {
    await handlePaidNoStock(order, 'QRIS');
    stopPolling(orderId);
  }
}

function startPolling(orderId) {
  if (pollTimers.has(orderId)) return;
  if (!config.pollSeconds || config.pollSeconds <= 0) return;
  const timer = setInterval(async () => {
    try {
      await autoCheck(orderId);
    } catch {
      // biarkan polling berikutnya mencoba lagi
    }
  }, config.pollSeconds * 1000);
  // Jangan menahan proses Node tetap hidup hanya karena polling
  if (typeof timer.unref === 'function') timer.unref();
  pollTimers.set(orderId, timer);
}

// Lanjutkan polling order pending setelah restart.
async function resumePolling() {
  try {
    const orders = await readJson(ordersFile);
    let resumed = 0;
    for (const [id, o] of Object.entries(orders)) {
      if (o && o.status === 'pending' && !isExpired(o)) {
        startPolling(id);
        resumed++;
      }
    }
    if (resumed) console.log(`Resume ${resumed} order pending`);
  } catch (e) {
    console.error('Gagal resume polling:', e.message);
  }
}

function formatRupiah(n) {
  return `Rp${Number(n || PRICE).toLocaleString('id-ID')}`;
}

async function getStockCount() {
  try {
    const stock = await readJson(stockFile);
    return Array.isArray(stock) ? stock.length : 0;
  } catch {
    return 0;
  }
}

function stockBar(percent) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return '■'.repeat(filled) + '□'.repeat(10 - filled);
}

// Tampilan /start gaya auto-order dengan stok & saldo live.
// Kalau stok < 2, tombol beli diganti tombol refresh (order diblokir di action 'buy' juga).
async function buildStart(name, chatId) {
  const remaining = await getStockCount();
  const balance = chatId ? await getBalance(chatId) : 0;
  const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
  const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const empty = remaining < 2;
  const text =
    `ᴀᴜᴛᴏ ᴏʀᴅᴇʀ VPS NAT • ᴄᴇᴘᴀᴛ & ᴛᴇʀᴘᴇʀᴄᴀʏᴀ\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👋 ʜᴀʟᴏ, ${name}!\n` +
    `sᴇʟᴀᴍᴀᴛ ᴅᴀᴛᴀɴɢ ᴅɪ ʙᴏᴛ ᴀᴜᴛᴏ ᴏʀᴅᴇʀ ᴋᴀᴍɪ 🚀\n\n` +
    `💰 sᴀʟᴅᴏ ᴀɴᴅᴀ: ${formatRupiah(balance)}\n\n` +
    `📦 ɪɴꜰᴏ ᴘʀᴏᴅᴜᴋ\n` +
    `├ ᴘʀᴏᴅᴜᴋ : VPS NAT\n` +
    `├ ʜᴀʀɢᴀ : ${formatRupiah(UNIT_PRICE)} / ᴜɴɪᴛ\n` +
    `├ ᴍɪɴɪᴍᴀʟ : 2 ᴜɴɪᴛ\n` +
    `└ sᴘᴇsɪꜰɪᴋᴀsɪ : ${config.productSpec}\n\n` +
    `📊 sᴛᴏᴋ ᴛᴇʀsᴇᴅɪᴀ\n` +
    `├ ${stockBar(percent)} ${percent}%\n` +
    `└ sɪsᴀ : ${remaining} / ${total} ᴜɴɪᴛ\n` +
    (empty ? `\n❌ sᴛᴏᴋ ʜᴀʙɪs — ᴄᴏʙᴀ ʟᴀɢɪ ɴᴀɴᴛɪ.\n` : ``) +
    `\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n` +
    `⚡️ ᴘʀᴏsᴇs ᴏᴛᴏᴍᴀᴛɪs sᴇᴛᴇʟᴀʜ ᴘᴇᴍʙᴀʏᴀʀᴀɴ\n` +
    `🔒 ᴀᴍᴀɴ, ᴄᴇᴘᴀᴛ & ᴛᴇʀᴘᴇʀᴄᴀʏᴀ\n\n` +
    `👇 ᴋʟɪᴋ ᴛᴏᴍʙᴏʟ ᴅɪ ʙᴀᴡᴀʜ ʙᴜᴀᴛ ᴍᴜʟᴀɪ ᴏʀᴅᴇʀ!`;
  const buttons = empty
    ? Markup.inlineKeyboard([[Markup.button.callback('🔄 Cek Stok', 'cek_stok')]])
    : Markup.inlineKeyboard([
        [Markup.button.callback(`🛒 Beli 2 VPS — ${formatRupiah(PRICE)} (QRIS)`, 'buy')],
        [Markup.button.callback('💰 Beli pakai Saldo', 'buy_balance'), Markup.button.callback('➕ Top Up', 'topup')],
      ]);
  return { text, buttons };
}

bot.start(async (ctx) => {
  const name = ctx.from?.first_name || 'kak';
  const { text, buttons } = await buildStart(name, getChatId(ctx));
  await ctx.reply(text, buttons);
});

bot.action('cek_stok', async (ctx) => {
  try {
    const name = ctx.from?.first_name || 'kak';
    const { text, buttons } = await buildStart(name, getChatId(ctx));
    await ctx.answerCbQuery();
    await ctx.reply(text, buttons);
  } catch {
    await ctx.answerCbQuery('Gagal cek stok.');
  }
});

bot.command('saldo', async (ctx) => {
  const chatId = getChatId(ctx);
  const balance = await getBalance(chatId);
  await ctx.reply(
    `💰 Saldo kamu: ${formatRupiah(balance)}\n\nTop up dulu sebelum beli pakai saldo. 1 order (2 VPS) = ${formatRupiah(PRICE)}.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Top Up Saldo', 'topup')],
      [Markup.button.callback(`💰 Beli 2 VPS — ${formatRupiah(PRICE)}`, 'buy_balance')],
    ])
  );
});

// Kirim QR sebagai foto (tanpa link): gambar di-download server lalu di-upload
// sebagai file, jadi Telegram tidak perlu fetch URL host gambar (sering gagal).
async function sendQrisPhoto(ctx, qris, order, caption) {
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Cek pembayaran', `check:${order.id}`)],
    [Markup.button.callback('❌ Batalkan pembayaran', `cancel:${order.id}`)],
  ]);
  const photoOpts = {
    caption: caption.slice(0, 1000),
    ...buttons,
  };
  let sent = false;
  try {
    const imgRes = await fetch(qris.image);
    if (!imgRes.ok) throw new Error(`Gambar HTTP ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (!buf.length) throw new Error('Gambar kosong');
    await ctx.replyWithPhoto({ source: buf }, photoOpts);
    sent = true;
  } catch {}
  if (!sent) {
    try {
      await ctx.replyWithPhoto({ url: qris.image }, photoOpts);
      sent = true;
    } catch {}
  }
  if (!sent) {
    await ctx.reply(
      `${caption}\n\n⚠️ Foto QR gagal dimuat. Batalkan pesanan ini lalu buat lagi untuk QR baru.`,
      buttons
    );
  }
}

function qrisExpiryText(qris) {
  return qris.expiredAt
    ? `⏰ Bayar sebelum: ${new Date(qris.expiredAt).toLocaleString('id-ID')}`
    : `⏰ Batas: ${config.timeoutMinutes} menit`;
}

bot.action('buy', async (ctx) => {
  try {
    const stock = await readJson(stockFile);
    if (!Array.isArray(stock) || stock.length < 2) return ctx.answerCbQuery('Stok habis.');
  } catch (e) {
    return ctx.answerCbQuery('Stok belum siap.');
  }
  try {
    const qris = await createQris(PRICE);
    const chatId = getChatId(ctx);
    const order = {
      id: randomUUID(),
      kind: 'buy',
      payMethod: 'qris',
      chatId,
      buyerName: ctx.from?.first_name || '',
      reference: qris.reference,
      createdAt: Date.now(),
      expiredAt: qris.expiredAt,
      total: qris.total,
      status: 'pending',
    };
    const orders = await readJson(ordersFile);
    orders[order.id] = order;
    await writeJson(ordersFile, orders);
    startPolling(order.id);

    const caption =
      `Bayar ${formatRupiah(qris.total)} (total sudah termasuk kode unik) lewat QR di foto ini.\n\n` +
      `Reference: ${qris.reference}\n` +
      qrisExpiryText(qris);
    await sendQrisPhoto(ctx, qris, order, caption);
    await ctx.answerCbQuery();
  } catch (error) {
    await ctx.answerCbQuery('Gagal membuat QRIS.');
    await ctx.reply(`Gagal: ${error.message}`);
  }
});

// ---- Deposit / Top Up Saldo ----
const TOPUP_OPTIONS = [10000, 20000, 50000, 100000];

bot.action('topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `➕ Top Up Saldo\nPilih nominal (saldo masuk sebesar nominal ini, kode unik tidak dihitung):`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Rp10.000', 'topup:10000'), Markup.button.callback('Rp20.000', 'topup:20000')],
      [Markup.button.callback('Rp50.000', 'topup:50000'), Markup.button.callback('Rp100.000', 'topup:100000')],
    ])
  );
});

bot.action(/^topup:(\d+)$/, async (ctx) => {
  const nominal = Number(ctx.match[1]);
  if (!TOPUP_OPTIONS.includes(nominal)) return ctx.answerCbQuery('Nominal tidak valid.');
  try {
    const qris = await createQris(nominal);
    const chatId = getChatId(ctx);
    const order = {
      id: randomUUID(),
      kind: 'topup',
      chatId,
      buyerName: ctx.from?.first_name || '',
      reference: qris.reference,
      createdAt: Date.now(),
      expiredAt: qris.expiredAt,
      total: qris.total,
      amount: qris.nominal,
      status: 'pending',
    };
    const orders = await readJson(ordersFile);
    orders[order.id] = order;
    await writeJson(ordersFile, orders);
    startPolling(order.id);

    const caption =
      `Top up ${formatRupiah(qris.nominal)} lewat QR di foto ini.\n` +
      `Bayar ${formatRupiah(qris.total)} (termasuk kode unik).\n\n` +
      `Reference: ${qris.reference}\n` +
      qrisExpiryText(qris);
    await sendQrisPhoto(ctx, qris, order, caption);
    await ctx.answerCbQuery();
  } catch (error) {
    await ctx.answerCbQuery('Gagal membuat QRIS.');
    await ctx.reply(`Gagal: ${error.message}`);
  }
});

// ---- Beli pakai saldo ----
bot.action('buy_balance', async (ctx) => {
  const chatId = getChatId(ctx);
  const buyerName = ctx.from?.first_name || '';
  const result = await withStockLock(async () => {
    const stock = await readJson(stockFile);
    if (!Array.isArray(stock) || stock.length < 2) return { ok: false, reason: 'habis' };
    const users = await readJson(usersFile);
    const bal = Number(users?.[chatId]?.balance || 0);
    if (bal < PRICE) return { ok: false, reason: 'saldo', bal };
    users[chatId] = { ...(users[chatId] || {}), balance: bal - PRICE, name: buyerName || users[chatId]?.name };
    const vps = stock.splice(0, 2);
    const orders = await readJson(ordersFile);
    const order = {
      id: randomUUID(),
      kind: 'buy',
      payMethod: 'balance',
      chatId,
      buyerName,
      reference: null,
      createdAt: Date.now(),
      deliveredAt: Date.now(),
      total: PRICE,
      status: 'delivered',
      vps,
    };
    orders[order.id] = order;
    await writeJson(usersFile, users);
    await writeJson(stockFile, stock);
    await writeJson(ordersFile, orders);
    return { ok: true, order, vps, left: stock.length };
  });
  if (!result.ok && result.reason === 'habis') return ctx.answerCbQuery('Stok habis.');
  if (!result.ok && result.reason === 'saldo') {
    await ctx.answerCbQuery('Saldo kurang.');
    await ctx.reply(
      `💰 Saldo kamu ${formatRupiah(result.bal)}, kurang untuk 1 order (${formatRupiah(PRICE)}). Top up dulu ya.`,
      Markup.inlineKeyboard([[Markup.button.callback('➕ Top Up Saldo', 'topup')]])
    );
    return;
  }
  try {
    await ctx.telegram.sendMessage(
      chatId,
      `VPS Berhasil Dibuat (Saldo)\n───────────◆───────────\n\n${vpsMessage(result.vps[0], 1)}\n\n───────────◆───────────\n\n${vpsMessage(result.vps[1], 2)}\n\nSimpan baik-baik. Jangan share ke orang lain.`
    );
  } catch {}
  await afterBuySuccess(result.order, result.vps);
  await ctx.answerCbQuery('Pembayaran saldo berhasil. Data dikirim.');
});

bot.action(/^check:(.+)$/, async (ctx) => {
  try {
    await verifyAndDeliver(ctx, ctx.match[1]);
  } catch (error) {
    await ctx.answerCbQuery('Gagal cek pembayaran.');
    await ctx.reply(`Gagal: ${error.message}`);
  }
});

bot.action(/^cancel:(.+)$/, async (ctx) => {
  try {
    const orders = await readJson(ordersFile);
    const order = orders[ctx.match[1]];
    const chatId = getChatId(ctx);
    if (!order || (chatId && order.chatId !== chatId)) return ctx.answerCbQuery('Pesanan tidak ditemukan.');
    if (order.status === 'delivered' || order.status === 'credited') return ctx.answerCbQuery('Sudah diproses, tidak bisa dibatalkan.');
    if (order.status === 'cancelled') return ctx.answerCbQuery('Pesanan sudah dibatalkan.');
    if (!order.reference) return ctx.answerCbQuery('Pesanan saldo tidak bisa dibatalkan.');
    // Kalau ternyata sudah bayar, langsung kirim VPS daripada dibatalkan
    try {
      if (await checkPayment(order)) {
        await verifyAndDeliver(ctx, order.id);
        return;
      }
    } catch {}
    try {
      await cancelPayment(order);
    } catch (e) {
      await ctx.answerCbQuery('Gagal batalkan.');
      await ctx.reply(`Gagal batal: ${e.message}`).catch(() => {});
      return;
    }
    order.status = 'cancelled';
    await writeJson(ordersFile, orders);
    stopPolling(order.id);
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    } catch {}
    await ctx.answerCbQuery('Pembayaran dibatalkan.');
    await ctx.reply('❌ Pembayaran dibatalkan. Silakan buat pesanan baru dengan /start kalau mau beli lagi.').catch(() => {});
  } catch (error) {
    await ctx.answerCbQuery('Gagal batalkan.');
    await ctx.reply(`Gagal: ${error.message}`).catch(() => {});
  }
});

// ---- Perintah admin ----
bot.command('stok', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const remaining = await getStockCount();
  const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
  const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
  await ctx.reply(`📊 Stok VPS: ${remaining} / ${total} (${percent}%)\n${stockBar(percent)}`);
});

// Format: /tambahstok lalu tiap baris: ip|port|user|pass  (atau dipisah koma/spasi)
bot.command('tambahstok', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const payload = (ctx.message?.text || '').replace(/^\/tambahstok(@\w+)?/, '').trim();
  const lines = payload.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    await ctx.reply('Format:\n/tambahstok\nip|port|user|pass\nip|port|user|pass\n(contoh: 1.2.3.4|2222|root|rahasia)');
    return;
  }
  const stock = await readJson(stockFile);
  let added = 0;
  for (const line of lines) {
    const parts = line.split(/\s*[|,;]\s*|\s+/).filter(Boolean);
    const [ip, port, ...rest] = parts;
    if (!ip || !port) continue;
    let username = 'root';
    let password = '';
    if (rest.length >= 2) { username = rest[0]; password = rest.slice(1).join(' '); }
    else if (rest.length === 1) { password = rest[0]; }
    if (!password) continue;
    stock.push({ ip, port, username, password, status: 'ACTIVE' });
    added++;
  }
  if (!added) {
    await ctx.reply('Tidak ada baris valid. Format: ip|port|user|pass');
    return;
  }
  await writeJson(stockFile, stock);
  await notifyAdmins(`📦 Restok +${added} unit oleh ${ctx.from?.first_name || 'admin'}. Sisa: ${stock.length}`);
  await ctx.reply(`✅ +${added} stok. Sisa sekarang: ${stock.length} unit.`);
});

bot.command('riwayat', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const n = Math.max(1, Math.min(30, Number((ctx.message?.text || '').split(/\s+/)[1]) || 10));
  const orders = await readJson(ordersFile);
  const list = Object.values(orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, n);
  if (!list.length) {
    await ctx.reply('Belum ada order.');
    return;
  }
  const lines = list.map((o) => {
    const date = o.createdAt ? new Date(o.createdAt).toLocaleString('id-ID') : '-';
    const kind = (o.kind || 'buy') === 'topup' ? 'DEPOSIT' : `BELI (${o.payMethod || 'qris'})`;
    const amt = formatRupiah(o.kind === 'topup' ? o.amount : o.total);
    return `• ${date}\n  ${kind} ${amt} — ${o.status} — ${(o.buyerName || o.chatId)} — ${(o.reference || o.id || '').toString().slice(0, 18)}`;
  });
  await ctx.reply(`🧾 ${list.length} order terakhir:\n\n${lines.join('\n\n').slice(0, 3500)}`);
});

// Format: /tambahsaldo <id_telegram> <nominal>  (contoh: /tambahsaldo 123456 10000)
bot.command('tambahsaldo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = (ctx.message?.text || '').replace(/^\/tambahsaldo(@\w+)?/, '').trim().split(/\s+/).filter(Boolean);
  if (args.length < 2) {
    await ctx.reply('Format:\n/tambahsaldo <id_telegram> <nominal>\nContoh: /tambahsaldo 123456 10000');
    return;
  }
  const targetId = args[0].replace(/[^0-9]/g, '');
  const nominal = Math.floor(Number(args[1]));
  if (!targetId || !Number.isFinite(nominal) || nominal <= 0) {
    await ctx.reply('ID / nominal tidak valid. Contoh: /tambahsaldo 123456 10000');
    return;
  }
  const users = await readJson(usersFile);
  const u = users[targetId] || { balance: 0 };
  u.balance = (Number(u.balance) || 0) + nominal;
  users[targetId] = u;
  await writeJson(usersFile, users);
  await ctx.reply(`✅ Saldo ${targetId} +${formatRupiah(nominal)}. Sekarang: ${formatRupiah(u.balance)}`);
  try {
    await bot.telegram.sendMessage(targetId, `💰 Admin menambah saldo kamu +${formatRupiah(nominal)}.\n💳 Saldo sekarang: ${formatRupiah(u.balance)}`);
  } catch {}
});

// ---- Start ----
try {
  await ensureData();
} catch (e) {
  console.error(`Gagal start: ${e.message}`);
  process.exit(1);
}

await resumePolling();

console.log('Menghubungkan ke Telegram...');
console.log(`Topup: ${config.topupUrl}`);
console.log(`Status: ${config.statusUrl}`);
getSharp().then((s) =>
  console.log(s ? 'Testimoni gambar: AKTIF (sharp)' : 'Testimoni gambar: TEKS SAJA (sharp belum diinstall — jalankan npm install)')
);

// Jangan await launch: Telegraf long-polling tidak resolve selama jalan,
// dan kalau token dipakai di 2 tempat (VPS + localhost) bakal 409 Conflict.
// Pakai then/catch biar error tetap kelihatan.
bot.launch()
  .then(() => console.log('Bot aktif'))
  .catch((e) => {
    console.error(`Gagal launch Telegram: ${e.message}`);
    console.error('Kemungkinan: BOT_TOKEN salah, atau bot sudah jalan di tempat lain (matikan dulu di VPS kalau mau test localhost).');
    process.exit(1);
  });

bot.catch((err) => console.error('Bot error:', err?.message || err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
