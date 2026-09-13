import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac } from 'node:crypto';
import {
  balance as otpBalance,
  cachedServices,
  cachedCountries,
  cheapestProvider,
  operatorsV2,
  createOrderV2,
  orderStatus as otpStatus,
  setOrderStatus as otpSetStatus,
  createDeposit,
  depositStatus,
  cancelDeposit,
  depositPaid,
  extractOtp,
  sellPrice,
  NOKOS_CATALOG,
} from './lib/rumahotp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, 'data');
const stockFile = path.join(dataDir, 'vps_stock.json');
const stockExampleFile = path.join(dataDir, 'vps_stock.example.json');
const ordersFile = path.join(dataDir, 'orders.json');
const usersFile = path.join(dataDir, 'users.json');
const groupsFile = path.join(dataDir, 'group_config.json');

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
const UNIT_PRICE = Number(process.env.PRICE || 1000); // 1 VPS = 1k, tanpa minimal

const config = {
  qrisToken: process.env.QRIS_TOKEN,
  qrisSecret: process.env.QRIS_API_SECRET || '',
  // Payment QRIS: auth ?apikey=... + IP whitelist di dashboard.
  // QRIS_TOKEN di .env = apikey payment (apg_live_...).
  // Kalau API secret (HMAC) aktif di dashboard, wajib isi QRIS_API_SECRET:
  // request dikirim lewat header X-API-Key + X-Timestamp + X-Signature.
  // Endpoin bawaan di bawah; override via .env bila perlu.
  topupUrl: process.env.QRIS_TOPUP_URL || 'https://austinstore.id/api/deposit/create',
  statusUrl: process.env.QRIS_STATUS_URL || 'https://austinstore.id/api/deposit',
  cancelUrl: process.env.QRIS_CANCEL_URL || 'https://austinstore.id/api/deposit/cancel',
  pollSeconds: Number(process.env.PAYMENT_POLL_SECONDS || 15),
  timeoutMinutes: Number(process.env.PAYMENT_TIMEOUT_MINUTES || 10),
  // Total kapasitas stok untuk bar persen. Isi mis. 102. Kalau 0/kosong, total = sisa saat ini.
  stockTotal: Number(process.env.STOCK_TOTAL || 0),
  productSpec: process.env.PRODUCT_SPEC || 'NAT | Unlimited',
  // Spek host (dari neofetch VPS 2026-09-08). Catatan: NAT container lihat spek host;
  // alokasi riil per unit ikut PRODUCT_SPEC. Update VPS_SPECS bila host ganti.
  vpsSpecs: String(process.env.VPS_SPECS || 'Xeon Platinum 8581C (32 Core),RAM 258GB DDR5,NVMe SSD,Google Cloud Network').split(',').map((s) => s.trim()).filter(Boolean),
  adminIds: String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  testiGroupId: process.env.TESTI_GROUP_ID || '',
  promoGroupId: process.env.PROMO_GROUP_ID || '',
  testiLink: process.env.TESTI_LINK || 'https://t.me/testimonialnat',
  promoLink: process.env.PROMO_LINK || '',
  shopName: process.env.SHOP_NAME || 'VPS NAT Store',
  nokosMarkup: Number(process.env.NOKOS_MARKUP || 1000),
  nokosMaxActive: Number(process.env.NOKOS_MAX_ACTIVE || 3),
  nokosPollSeconds: Number(process.env.NOKOS_POLL_SECONDS || 12),
  nokosTimeoutMinutes: Number(process.env.NOKOS_TIMEOUT_MINUTES || 15),
};

const bot = new Telegraf(process.env.BOT_TOKEN);
let stockLock = Promise.resolve();
const pollTimers = new Map();

// ---- Panel Legal (bayar QRIS otomatis, delivery manual via admin) ----
const PANEL_PLANS = [
  { id: '1', label: '1 GB • 1024 MB • 1024 MB • 40%', price: 1000 },
  { id: '2', label: '2 GB • 2048 MB • 2048 MB • 60%', price: 2000 },
  { id: '3', label: '3 GB • 3072 MB • 3072 MB • 80%', price: 3000 },
  { id: '4', label: '4 GB • 4096 MB • 4096 MB • 100%', price: 4000 },
  { id: '5', label: '5 GB • 5120 MB • 5120 MB • 110%', price: 5000 },
  { id: '6', label: '6 GB • 6144 MB • 6144 MB • 120%', price: 6000 },
  { id: '7', label: '7 GB • 7168 MB • 7168 MB • 130%', price: 7000 },
  { id: '8', label: '8 GB • 8192 MB • 8192 MB • 140%', price: 8000 },
  { id: '9', label: '9 GB • 9216 MB • 9216 MB • 150%', price: 9000 },
  { id: '10', label: '10 GB • 10240 MB • 10240 MB • 200%', price: 10000 },
  { id: 'unli', label: 'Unlimited • ∞ • ∞ • ∞', price: 15000 },
];
// chatId -> planId yang lagi nunggu input username
const panelWaitUsername = new Map();
// chatId -> { planId, username } yang lagi pilih metode bayar
const pendingPanelPay = new Map();

function panelPlanById(id) {
  return PANEL_PLANS.find((p) => p.id === String(id));
}

function panelListKeyboard() {
  const rows = [];
  for (const p of PANEL_PLANS) {
    rows.push([Markup.button.callback(`📦 ${p.label} — ${formatRupiah(p.price)}`, `pbuy:${p.id}`)]);
  }
  rows.push([Markup.button.callback('⬅️ Kembali', 'cek_stok')]);
  return Markup.inlineKeyboard(rows);
}

function panelIntroText() {
  const list = PANEL_PLANS.map((p) => `• ${p.label} — ${formatRupiah(p.price)}`).join('\n');
  return `🛡️ PANEL PREMIUM — Garansi Penuh 30 Hari\n\n` +
    `Panel resmi 100% legal & aman.\n` +
    `Bermasalah? Langsung diganti baru — garansi penuh 30 hari.\n\n` +
    `📋 Daftar Paket Panel:\n${list}\n\n` +
    `👇 Pilih salah satu paket di bawah, lalu kirim username panel yang kamu inginkan.`;
}

// Order panel lunas: notif admin + pesan tunggu ke user.
// Testi TIDAK auto — nunggu admin /balas dulu, buyer ditanya mau kirim testi apa enggak.
async function afterPanelPaid(order) {
  const planLabel = order.panelLabel || order.panelId;
  const via = order.payMethod === 'balance' ? 'SALDO' : 'QRIS';
  try {
    await notifyAdmins(
      `🛒 Ada yang beli panel!\n👤 ${order.buyerName || 'User'} (${order.chatId})\n📦 Panel ${planLabel}\n👤 Username: ${order.panelUsername || '-'}\n💰 ${formatRupiah(order.total || 0)} via ${via}\nRef: ${order.reference || order.id}\n\nBalas pakai:\n/balas ${order.chatId} <detail panel / user / pass>`
    );
  } catch {}
  try {
    await bot.telegram.sendMessage(
      order.chatId,
      `✅ Pembayaran Berhasil!\n━━━━━━━━━━━━━━━━━━\n📦 Panel ${planLabel}\n👤 Username : ${order.panelUsername || '-'}\n\nPesananmu sedang diproses — mohon tunggu balasan admin ya 🙏`
    );
  } catch {}
}

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
    await access(groupsFile, constants.F_OK);
  } catch {
    await writeJson(groupsFile, {});
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

// ---- Helpers QRIS (payment) ----
// Create:  POST {topupUrl}?apikey=KEY  body { amount }
//   -> { success:true, deposit:{ id, transaction_id, amount, unique_code, fee,
//        qr_string, qr_image, expired_at, status } }
//   `amount` respons SUDAH termasuk fee + unique_code -> user bayar pas segitu.
// Check:   GET {base}/api/deposit/check/:transactionId?apikey=KEY
//   -> { success:true, status:"pending"|"paid"|"expired" }
// Cancel:  POST {base}/api/deposit/cancel/:transactionId?apikey=KEY
//   -> { success:true, status:"cancel" } (paid/expired tak bisa dibatalkan)
// Rate limit create: 5 req/menit per key. Poll check minimal tiap 5 detik.

function paymentDeposit(response) {
  return response?.deposit || response?.data || null;
}

function paymentImage(response) {
  const dep = paymentDeposit(response);
  return (
    dep?.qr_image || dep?.qris_image ||
    response.qr_image || response.qris_image ||
    dep?.image || response.image || null
  );
}

function paymentReference(response) {
  const dep = paymentDeposit(response);
  return dep?.transaction_id || dep?.id || response.transaction_id || response.invoice_id || null;
}

function paymentTotal(response, fallback = PRICE) {
  const dep = paymentDeposit(response);
  return dep?.amount || response.total || response.amount || fallback;
}

function paymentNominal(response, fallback) {
  const dep = paymentDeposit(response);
  if (dep && typeof dep.amount === 'number') {
    const fee = Number(dep.fee || 0);
    const uniq = Number(dep.unique_code || 0);
    if (fee || uniq) return dep.amount - fee - uniq;
    return fallback;
  }
  return response.amount || fallback;
}

function paymentExpiredAt(response) {
  const dep = paymentDeposit(response);
  return dep?.expired_at || response.expired_at || response.expiredAt || null;
}

// HMAC: kalau QRIS_API_SECRET diisi (secret aktif di dashboard),
// key dikirim via header X-API-Key + request ditandatangani:
//   signature = HMAC-SHA256(secret, "METHOD\nPATH\nBODY\nTIMESTAMP") hex,
//   header X-Signature + X-Timestamp. PATH = pathname murni tanpa query,
//   BODY = raw JSON persis yg dikirim ("" kalau tanpa body).
function paymentPath(url, fallback) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || fallback;
  } catch {
    return fallback;
  }
}

function paymentSignedHeaders(method, path, bodyStr) {
  const timestamp = Date.now().toString();
  const payload = `${method}\n${path}\n${bodyStr}\n${timestamp}`;
  const signature = createHmac('sha256', config.qrisSecret).update(payload).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-API-Key': config.qrisToken,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };
}

function paymentKeyQuery(url) {
  return `${url}${url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(config.qrisToken)}`;
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
  return `✦ VPS READY — Unit ${index} ✦\n━━━━━━━━━━━━━━━━━━\n👤 Username : ${vps.username || 'root'}\n🔐 Password : ${vps.password}\n🌐 IP Address : ${vps.ip}\n🔌 Port : ${vps.port}\n🟢 Status : ${vps.status || 'ACTIVE'}\n━━━━━━━━━━━━━━━━━━\n💻 Quick Connect\n\`ssh ${vps.username || 'root'}@${vps.ip} -p ${vps.port}\`\n━━━━━━━━━━━━━━━━━━\n🤫 Simpan baik-baik, jangan dibagikan ke siapa pun.`;
}

function getChatId(ctx) {
  return ctx.chat?.id ?? ctx.from?.id;
}

async function createQris(nominal = PRICE) {
  const bodyStr = JSON.stringify({ amount: Number(nominal) });
  let url = config.topupUrl;
  let headers = { 'Content-Type': 'application/json' };
  if (config.qrisSecret) {
    const path = paymentPath(url, '/api/deposit/create');
    headers = paymentSignedHeaders('POST', path, bodyStr);
  } else {
    url = paymentKeyQuery(url);
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyStr,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 429)
    throw new Error('Terlalu sering membuat QR. Mohon tunggu sebentar lalu coba lagi.');
  if (!response.ok || body.success === false)
    throw new Error(body.message || body.error || `QRIS HTTP ${response.status}`);
  const image = paymentImage(body);
  const reference = paymentReference(body);
  if (!image || !reference) {
    throw new Error(
      `Respons deposit tak dikenali (butuh deposit.qr_image + deposit.transaction_id). Dapat: ${JSON.stringify(body).slice(0, 300)}`
    );
  }
  const dep = paymentDeposit(body);
  return {
    image,
    content: dep?.qr_string || null,
    reference,
    total: paymentTotal(body, nominal),
    nominal: paymentNominal(body, nominal),
    expiredAt: paymentExpiredAt(body),
    cancelUrl: null,
    checkUrl: null,
    paymentLink: null,
    raw: body,
  };
}

async function checkPayment(order) {
  const reference = order.reference;
  if (!reference) return false;
  const base = String(config.statusUrl).replace(/\/+$/, '');
  let url = `${base}/check/${encodeURIComponent(reference)}`;
  let headers;
  if (config.qrisSecret) {
    const path = `${paymentPath(base, '/api/deposit')}/check/${encodeURIComponent(reference)}`;
    headers = paymentSignedHeaders('GET', path, '');
  } else {
    url = paymentKeyQuery(url);
  }
  const response = await fetch(url, { method: 'GET', ...(headers ? { headers } : {}) });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return false; // transaksi tak ada = belum bayar / salah id
  if (!response.ok) throw new Error(body.message || body.error || `Status QRIS HTTP ${response.status}`);
  return paid(body);
}

// Payment PUNYA cancel API: POST {cancelUrl}/:transactionId.
// Batal = stop polling + tandai cancelled lokal (dipanggil setelah cek paid).
async function cancelPayment(order) {
  const reference = order?.reference;
  if (!reference) return true;
  const base = String(config.cancelUrl).replace(/\/+$/, '');
  let url = `${base}/${encodeURIComponent(reference)}`;
  let headers;
  if (config.qrisSecret) {
    const path = `${paymentPath(base, '/api/deposit/cancel')}/${encodeURIComponent(reference)}`;
    headers = paymentSignedHeaders('POST', path, '');
  } else {
    url = paymentKeyQuery(url);
  }
  const response = await fetch(url, { method: 'POST', ...(headers ? { headers } : {}) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 400)
    throw new Error(body.message || body.error || `Cancel QRIS HTTP ${response.status}`);
  if (body.success === false && /paid|lunas|berhasil/i.test(String(body.message || '')))
    throw new Error('Deposit sudah dibayar, tidak bisa dibatalkan.');
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

// ---- Wajib join GB Testimoni + Broadcast ke GB Promosi ----
async function isJoinedTesti(userId) {
  const gid = await getTestiId();
  if (!gid) return true; // fitur mati kalau ID belum diset
  try {
    const m = await bot.telegram.getChatMember(gid, userId);
    return ['creator', 'administrator', 'member', 'restricted'].includes(m?.status);
  } catch {
    return false; // bot belum masuk grup / ID salah -> anggap belum join biar ketahuan
  }
}

function joinGateButtons() {
  const rows = [[Markup.button.url('⭐ Gabung GB Testimoni', config.testiLink)]];
  rows.push([Markup.button.callback('✅ Saya Sudah Gabung', 'cek_join')]);
  return Markup.inlineKeyboard(rows);
}

// ---- Daftar GB promosi: [{id, title}], + blocked: [id] ----
// Normalisasi: dukung format lama (array string) biar gak rusak pas update.
function normGroups(g) {
  const out = [];
  const raw = Array.isArray(g?.promoGroups) ? g.promoGroups : [];
  for (const e of raw) {
    if (typeof e === 'string') out.push({ id: String(e), title: '' });
    else if (e && e.id) out.push({ id: String(e.id), title: String(e.title || '') });
  }
  if (g?.promoGroupId) out.push({ id: String(g.promoGroupId), title: '' });
  if (config.promoGroupId) out.push({ id: String(config.promoGroupId), title: '' });
  const seen = new Set(), res = [];
  for (const e of out) {
    if (!e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    res.push(e);
  }
  return res;
}
function normBlocked(g) {
  const raw = Array.isArray(g?.blockedGroups) ? g.blockedGroups : [];
  return [...new Set(raw.map(String))];
}

async function sendToPromo(ctx, text, extra = {}) {
  const { list } = await getPromoTargets();
  if (!list.length) {
    await ctx.reply('🔍 Bot belum tergabung di grup promosi mana pun.\nTambahkan bot ke grup promosi, lalu jalankan /broadcast lagi.');
    return false;
  }
  let ok = 0;
  for (const t of list) {
    try {
      await bot.telegram.sendMessage(t.id, text, extra);
      ok++;
    } catch (e) {
      console.error(`Gagal kirim promosi ke ${t.id}:`, e.message);
    }
  }
  if (!ok) {
    await ctx.reply('😔 Gagal mengirim ke semua grup. Pastikan bot masih berada di grup & menjadi admin/anggota.');
    return false;
  }
  return true;
}

// ID grup auto-daftar (tanpa copy manual): .env dulu, kalau kosong pakai data/group_config.json
async function getPromoId() {
  if (config.promoGroupId) return config.promoGroupId;
  try {
    const g = await readJson(groupsFile);
    const list = normGroups(g);
    if (list.length) return list[0].id;
    return g?.promoGroupId || '';
  } catch { return ''; }
}
// Semua target broadcast: semua grup yang dikenal KECUALI grup testimoni + yang di-block.
// Jadi GB apapun yang bot dimasukin otomatis jadi target promosi.
async function getPromoTargets() {
  try {
    const g = await readJson(groupsFile);
    const testi = String(config.testiGroupId || '');
    const blocked = new Set(normBlocked(g));
    const list = normGroups(g).filter((e) => e.id !== testi && !blocked.has(e.id));
    return { list, testi };
  } catch { return { list: config.promoGroupId ? [{ id: String(config.promoGroupId), title: '' }] : [], testi: '' }; }
}
async function getTestiId() {
  return config.testiGroupId || '';
}
async function saveGroupId(key, value) {
  let g = {};
  try { g = await readJson(groupsFile); } catch {}
  g[key] = value;
  await writeJson(groupsFile, g);
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

// Kartu gambar spek VPS (gaya neofetch) — /spek kirim foto ini.
function specSvg({ rows, pingVps, pingBot, stock }) {
  const shop = escXml(config.shopName);
  const line = (y, k, v, color = '#ffffff') =>
    `<text x="110" y="${y}" font-family="Arial,sans-serif" font-size="23" fill="#94a3b8">${escXml(k)}</text>` +
    `<text x="300" y="${y}" font-family="Arial,sans-serif" font-size="23" font-weight="bold" fill="${color}">: ${escXml(v)}</text>`;
  return `<svg width="800" height="600" viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#1b2a4a"/>
</linearGradient>
<linearGradient id="acc" x1="0" y1="0" x2="1" y2="0">
<stop offset="0" stop-color="#22c55e"/><stop offset="1" stop-color="#22d3ee"/>
</linearGradient>
</defs>
<rect x="8" y="8" width="784" height="584" rx="24" fill="url(#bg)" stroke="#22c55e" stroke-width="3"/>
<rect x="8" y="8" width="784" height="10" rx="5" fill="url(#acc)"/>
<text x="400" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="38" font-weight="bold" fill="#ffffff" letter-spacing="2">SPESIFIKASI VPS</text>
<rect x="110" y="102" width="580" height="4" rx="2" fill="url(#acc)"/>
${line(155, 'OS', rows.os || 'Ubuntu 22.04.5 LTS x86_64')}
${line(200, 'Host', rows.host || 'Google Compute Engine')}
${line(245, 'Kernel', rows.kernel || '6.18.15 cloud-amd64')}
${line(290, 'CPU', rows.cpu || 'Xeon Platinum 8581C (32) @ 2.1GHz', '#22d3ee')}
${line(335, 'RAM', rows.ram || '258GB DDR5', '#22c55e')}
${line(380, 'Uptime', rows.uptime || '47+ hari nonstop')}
${line(425, 'Harga', formatRupiah(UNIT_PRICE) + ' / unit', '#fbbf24')}
${line(470, 'Ping VPS', pingVps === null ? '—' : pingVps + ' ms', '#22c55e')}
${line(515, 'Stok', stock + ' unit ready')}
<rect x="110" y="535" width="580" height="4" rx="2" fill="url(#acc)"/>
<text x="400" y="572" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="#ffffff">${shop}</text>
</svg>`;
}

async function sendSpecCard(ctx, quiet = false) {
  let stock = 0, os = null, pingVps = null;
  try {
    const s = await readJson(stockFile);
    stock = Array.isArray(s) ? s.length : 0;
    const first = Array.isArray(s) ? s.find((v) => v && v.ip) : null;
    if (first) {
      os = first.os || null;
      const p0 = Date.now();
      const sock = (await import('node:net')).default;
      await new Promise((resolve) => {
        const c = sock.connect(Number(first.port) || 22, first.ip);
        c.setTimeout(3000);
        c.on('connect', () => { pingVps = Date.now() - p0; c.destroy(); resolve(); });
        c.on('timeout', () => { c.destroy(); resolve(); });
        c.on('error', () => resolve());
      });
    }
  } catch {}
  const sharp = await getSharp();
  const caption = quiet
    ? `💻 Spesifikasi VPS ${config.shopName} — detail & order di bawah 👇`
    : `💻 Spesifikasi VPS ${config.shopName}\n💰 ${formatRupiah(UNIT_PRICE)}/unit — ketik /start untuk order.`;
  if (sharp) {
    try {
      const rows = {
        os: os || 'Ubuntu 22.04.5 LTS x86_64',
        host: 'Google Compute Engine',
        kernel: '6.18.15 cloud-amd64',
        cpu: 'Xeon Platinum 8581C (32) @ 2.1GHz',
        ram: '258GB DDR5',
        uptime: '47+ hari nonstop',
      };
      const buf = await sharp(Buffer.from(specSvg({ rows, pingVps, pingBot: null, stock }))).png().toBuffer();
      await ctx.replyWithPhoto({ source: buf }, { caption });
      return;
    } catch (e) { console.error('Gagal bikin kartu spek:', e.message); }
  }
  await ctx.reply(caption + `\n━━━━━━━━━━━━━━━━━━\n🖥️ OS : Ubuntu 22.04.5 LTS\n⚙️ CPU : Xeon Platinum 8581C (32)\n🧠 RAM : 258GB\n📦 Stok : ${stock} unit tersedia`);
}

bot.command('spek', async (ctx) => { await sendSpecCard(ctx); });

bot.action('lihat_spek', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendSpecCard(ctx);
});
async function sendTesti(kind, { name, detail, amount, ref }) {
  const gid = await getTestiId();
  if (!gid) return;
  const title = kind === 'topup' ? 'TESTIMONI DEPOSIT' : 'TESTIMONI PEMBELIAN';
  const date = new Date().toLocaleString('id-ID');
  const caption = `✅ ${title}\n👤 ${name}\n📦 ${detail}\n💰 ${amount}\n📅 ${date}`;
  const sharp = await getSharp();
  if (sharp) {
    try {
      const buf = await sharp(Buffer.from(testiSvg({ title, name, detail, amount, date, ref }))).png().toBuffer();
      await bot.telegram.sendPhoto(gid, { source: buf }, { caption });
      return;
    } catch (e) {
      console.error('Gagal bikin gambar testimoni:', e.message);
    }
  }
  // Fallback teks kalau sharp belum diinstall / gagal
  try {
    await bot.telegram.sendMessage(gid, `${caption}\nRef: ${ref}`);
  } catch (e) {
    console.error('Gagal kirim testimoni ke grup (cek TESTI_GROUP_ID & bot sudah masuk grup):', e.message);
  }
}

// Dipanggil tiap pembelian QRIS/saldo sukses: notif admin + testimoni grup.
async function afterBuySuccess(order, vps) {
  try {
    const left = await getStockCount();
    await notifyAdmins(
      `🛒 Penjualan!\n👤 ${order.buyerName || 'User'} (${order.chatId})\n📦 1x VPS NAT via ${order.payMethod === 'balance' ? 'SALDO' : 'QRIS'} ${formatRupiah(order.total || PRICE)}\n🌐 ${vps.map((v) => `${v.ip}:${v.port}`).join(', ')}\n📊 Sisa stok: ${left}\nRef: ${order.reference || String(order.id).slice(0, 8)}`
    );
  } catch {}
  try {
    await sendTesti('buy', {
      name: order.buyerName || 'Pembeli',
      detail: '1x VPS NAT',
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
      `✅ Pembayaran ${formatRupiah(order.total || PRICE)} kami terima, namun stok sedang habis.\nJangan khawatir — admin akan segera menghubungimu.\n🧾 Simpan referensi ini: ${order.reference || order.id}`
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
  if (stock.length < 1) throw new Error('Stok VPS habis.');
  const vps = stock.splice(0, 1);
  await writeJson(stockFile, stock);
  order.status = 'delivered';
  order.deliveredAt = Date.now();
  order.vps = vps;
  await writeJson(ordersFile, orders);
  await bot.telegram.sendMessage(
    order.chatId,
    `🎉 VPS Kamu Sudah Aktif!\n━━━━━━━━━━━━━━━━━━\n\n${vpsMessage(vps[0], 1)}`
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
      `✅ Isi Saldo Berhasil!\n━━━━━━━━━━━━━━━━━━\n💰 Nominal masuk : ${formatRupiah(order.amount)}\n💳 Saldo VPS kamu : ${formatRupiah(u.balance)}\n\nGunakan /start untuk order VPS dengan saldo.`
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
  if (order.status === 'paid_panel') {
    if (!auto) await ctx.answerCbQuery('Pembayaran berhasil. Menunggu admin.');
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
    else await bot.telegram.sendMessage(order.chatId, '⏰ Waktu pembayaran QRIS telah berakhir. Silakan buat pesanan baru via /start.').catch(() => {});
    return false;
  }
  let ok = false;
  try {
    ok = (order.kind === 'otp_topup' || order.provider === 'rumahotp') ? await checkDeposit(order) : await checkPayment(order);
  } catch (e) {
    if (!auto) {
      await ctx.answerCbQuery('Gagal mengecek pembayaran.');
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
  if (kind === 'otp_topup') {
    const credited = await creditOtpTopup(order.id);
    stopPolling(order.id);
    if (!auto) await ctx.answerCbQuery(credited ? 'Top up OTP berhasil.' : 'Sudah diproses.');
    return true;
  }
  if (kind === 'panel') {
    order.status = 'paid_panel';
    await writeJson(ordersFile, orders);
    stopPolling(order.id);
    await afterPanelPaid(order);
    if (!auto) await ctx.answerCbQuery('Pembayaran berhasil. Pesanan diproses admin.');
    return true;
  }
  if (kind === 'nokos_pending') {
    stopPolling(order.id);
    if (!auto) await ctx.answerCbQuery('Bayar lunas. Order nomor...');
    await activateNokos(order.id);
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

// Anti QR ganda: 1 chat cuma boleh punya 1 pembayaran pending.
// Tap ke-2 (double-tap / spam tombol) ditolak + disuruh bayar/batalkan QR yg ada.
// withPayLock bikin sekuens per chat biar 2 tap barengan ga lolos bareng.
const payQueue = new Map();
function withPayLock(chatId, fn) {
  const key = String(chatId ?? '');
  const prev = payQueue.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  payQueue.set(key, tail);
  tail.finally(() => { if (payQueue.get(key) === tail) payQueue.delete(key); });
  return next;
}

async function findPendingPayment(chatId) {
  try {
    const orders = await readJson(ordersFile);
    for (const o of Object.values(orders)) {
      if (!o || o.chatId !== chatId || o.status !== 'pending' || !o.reference) continue;
      if (!['buy', 'topup', 'panel', 'nokos_pending', 'otp_topup'].includes(o.kind || 'buy')) continue;
      if (isExpired(o)) continue;
      return o;
    }
  } catch {}
  return null;
}

async function refuseIfPending(ctx, chatId) {
  const dup = await findPendingPayment(chatId);
  if (!dup) return false;
  await ctx.answerCbQuery('Kamu masih memiliki QR aktif.').catch(() => {});
  await ctx.reply(
    `⏳ Selesaikan pembayaran QR sebelumnya dulu (ref: ${dup.reference}) atau batalkan sebelum membuat yang baru.`
  ).catch(() => {});
  return true;
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
    await bot.telegram.sendMessage(order.chatId, '⏰ Waktu pembayaran QRIS telah berakhir. Silakan buat pesanan baru via /start.').catch(() => {});
    return;
  }
  let ok = false;
  try {
    ok = (order.kind === 'otp_topup' || order.provider === 'rumahotp') ? await checkDeposit(order) : await checkPayment(order);
  } catch {
    return; // coba lagi di tick berikutnya
  }
  if (!ok) return;
  if ((order.kind || 'buy') === 'topup') {
    await creditTopup(order.id);
    stopPolling(orderId);
    return;
  }
  if ((order.kind || 'buy') === 'otp_topup') {
    await creditOtpTopup(order.id);
    stopPolling(orderId);
    return;
  }
  if ((order.kind || 'buy') === 'panel') {
    const orders2 = await readJson(ordersFile);
    const o2 = orders2[orderId];
    if (o2 && o2.status === 'pending') {
      o2.status = 'paid_panel';
      await writeJson(ordersFile, orders2);
      await afterPanelPaid(o2);
    }
    stopPolling(orderId);
    return;
  }
  if ((order.kind || 'buy') === 'nokos_pending') {
    stopPolling(orderId);
    await activateNokos(orderId);
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

// Lanjutkan polling order pending + nokos aktif setelah restart.
async function resumePolling() {
  try {
    const orders = await readJson(ordersFile);
    let resumed = 0, nokos = 0;
    for (const [id, o] of Object.entries(orders)) {
      if (o && o.status === 'pending' && !isExpired(o)) {
        startPolling(id);
        resumed++;
      } else if (o && o.kind === 'nokos' && o.status === 'active') {
        startNokosPoll(id);
        nokos++;
      }
    }
    if (resumed) console.log(`Resume ${resumed} order pending`);
    if (nokos) console.log(`Resume ${nokos} nokos aktif`);
  } catch (e) {
    console.error('Gagal resume polling:', e.message);
  }
}

function formatRupiah(n) {
  return `Rp${Number(n ?? PRICE).toLocaleString('id-ID')}`;
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
  const t0 = Date.now();
  const remaining = await getStockCount();
  const balance = chatId ? await getBalance(chatId) : 0;
  const otpBal = chatId ? await getOtpBalance(chatId) : 0;
  let ping = null;
  try {
    await bot.telegram.getMe();
    ping = Date.now() - t0;
  } catch { ping = null; }
  // Spek live dari data stok: OS unit pertama + ping TCP ke IP stok pertama.
  let stockOs = null, stockPing = null;
  try {
    const stock = await readJson(stockFile);
    const first = Array.isArray(stock) ? stock.find((v) => v && v.ip) : null;
    if (first) {
      stockOs = first.os || null;
      const p0 = Date.now();
      const sock = (await import('node:net')).default;
      await new Promise((resolve) => {
        const s = sock.connect(Number(first.port) || 22, first.ip);
        s.setTimeout(3000);
        s.on('connect', () => { stockPing = Date.now() - p0; s.destroy(); resolve(); });
        s.on('timeout', () => { s.destroy(); resolve(); });
        s.on('error', () => resolve());
      });
    }
  } catch {}
  const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
  const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const empty = remaining < 1;
  const dot = empty ? '🔴' : percent < 30 ? '🟡' : '🟢';
  const specLines = config.vpsSpecs.map((s) => `│  • ${s}`).join('\n');
  const liveLines = [
    stockOs ? `│  • OS : ${stockOs}` : null,
    stockPing === null ? null : `│  • Ping VPS : ${stockPing} ms ${stockPing < 300 ? '🟢' : stockPing < 800 ? '🟡' : '🔴'}`,
    ping === null ? '│  • Ping Bot : —' : `│  • Ping Bot : ${ping} ms`,
  ].filter(Boolean).join('\n');
  const text =
    `✦ ${config.shopName} ✦\n` +
    `Selamat datang, ${name} 👋\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💳 <b>Saldo Anda : ${formatRupiah(balance)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>Katalog Produk</b>\n` +
    `• 🖥️ VPS NAT — <b>${formatRupiah(UNIT_PRICE)}/unit</b> · Uptime 24/7\n` +
    `• 🛡️ Panel Premium — mulai Rp1.000 · garansi 30 hari\n` +
    `• 📱 Nomor OTP — semua layanan &amp; negara\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `✨ <b>Dukungan admin yang responsif</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Ketersediaan VPS ${dot}</b>\n` +
    `${stockBar(percent)} <b>${percent}%</b>\n` +
    `└ ${remaining}/${total} unit tersedia\n` +
    (empty ? `😔 <b>Stok habis</b> — restok segera, pantau terus ya.\n` : ``) +
    `⚡ Order otomatis 24 jam setelah pembayaran\n\n` +
    `Silakan pilih menu di bawah untuk mulai 👇`;
  const rows = empty
    ? [[Markup.button.callback('🔄 Cek Stok', 'cek_stok')]]
    : [
        [Markup.button.callback(`🛒 Order VPS · ${formatRupiah(PRICE)}`, 'buy')],
        [Markup.button.callback('📱 Nomor OTP', 'nokos'), Markup.button.callback('💳 Bayar Pakai Saldo', 'buy_balance')],
        [Markup.button.callback('💳 Saldo Saya', 'saldo'), Markup.button.callback('➕ Isi Saldo', 'topup')],
        [Markup.button.callback('🛡️ Panel Premium · Garansi 30 Hari', 'panel_legal')],
      ];
  rows.push([Markup.button.callback('💬 Bantuan', 'contact_help'), Markup.button.url('⭐ Testimoni', config.testiLink)]);
  return { text, buttons: { ...Markup.inlineKeyboard(rows), parse_mode: 'HTML' } };
}

// Foto kartu spek saja (buffer) — dipakai /start gabungan. null kalau sharp gagal.
async function specPhoto() {
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    let stock = 0, os = null, pingVps = null;
    try {
      const s = await readJson(stockFile);
      stock = Array.isArray(s) ? s.length : 0;
      const first = Array.isArray(s) ? s.find((v) => v && v.ip) : null;
      if (first) {
        os = first.os || null;
        const p0 = Date.now();
        const sock = (await import('node:net')).default;
        await new Promise((resolve) => {
          const c = sock.connect(Number(first.port) || 22, first.ip);
          c.setTimeout(3000);
          c.on('connect', () => { pingVps = Date.now() - p0; c.destroy(); resolve(); });
          c.on('timeout', () => { c.destroy(); resolve(); });
          c.on('error', () => resolve());
        });
      }
    } catch {}
    const rows = {
      os: os || 'Ubuntu 22.04.5 LTS x86_64',
      host: 'Google Compute Engine',
      kernel: '6.18.15 cloud-amd64',
      cpu: 'Xeon Platinum 8581C (32) @ 2.1GHz',
      ram: '258GB DDR5',
      uptime: '47+ hari nonstop',
    };
    return await sharp(Buffer.from(specSvg({ rows, pingVps, pingBot: null, stock }))).png().toBuffer();
  } catch (e) { console.error('Gagal bikin kartu spek:', e.message); return null; }
}

// Teks menu versi caption foto (1024 char max) — kartu spek tetap dikirim sebagai gambar, di sini versi B.
function menuCaption(name, balance, otpBal, remaining, total, percent, dot, empty) {
  return (
    `✦ ${config.shopName} ✦ — Selamat datang, ${name} 👋\n` +
    `💳 Saldo : ${formatRupiah(balance)}\n` +
    `📦 VPS NAT ${formatRupiah(UNIT_PRICE)}/unit · Uptime 24/7 · Panel & OTP ready\n` +
    `✨ Dukungan admin yang responsif\n` +
    `📊 Stok : ${dot} ${remaining}/${total} (${percent}%) ${stockBar(percent)}\n` +
    (empty ? `😔 Stok habis — restok segera.\n` : ``) +
    `⚡ Order otomatis 24 jam · ⭐ Cek testimoni kami`
  ).slice(0, 1000);
}

bot.start(async (ctx) => {
  const name = ctx.from?.first_name || 'Kak';
  const chatId = getChatId(ctx);
  // GATE: wajib gabung GB Testimoni dulu sebelum menu utama muncul
  const joined = await isJoinedTesti(ctx.from.id);
  if (!joined) {
    await ctx.reply(
      `Halo, ${name}! Selamat datang 👋\n\n` +
      `Sebelum mulai order, silakan bergabung dulu ke grup testimoni kami:\n` +
      `👉 ${config.testiLink}\n\n` +
      `Klik tombol di bawah untuk bergabung, lalu tekan "✅ Saya Sudah Gabung".`,
      joinGateButtons()
    );
    return;
  }
  const { text, buttons } = await buildStart(name, chatId);
  // Gabung: 1 pesan foto (kartu spek) + caption menu + tombol. Fallback teks bila render gagal.
  const photo = await specPhoto();
  if (photo) {
    const remaining = await getStockCount();
  const balance = chatId ? await getBalance(chatId) : 0;
  const otpBal = chatId ? await getOtpBalance(chatId) : 0;
    const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
    const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
    const dot = remaining < 1 ? '🔴' : percent < 30 ? '🟡' : '🟢';
    await ctx.replyWithPhoto({ source: photo }, {
      caption: menuCaption(name, balance, otpBal, remaining, total, percent, dot, remaining < 1),
      ...buttons,
    }).catch(async () => { await ctx.reply(text, buttons); });
    return;
  }
  await ctx.reply(text, buttons);
});

bot.action('cek_stok', async (ctx) => {
  try {
    const name = ctx.from?.first_name || 'Kak';
    const { text, buttons } = await buildStart(name, getChatId(ctx));
    await ctx.answerCbQuery();
    await ctx.reply(text, buttons);
  } catch {
    await ctx.answerCbQuery('Gagal cek stok.');
  }
});

bot.command('saldo', async (ctx) => {
  await showSaldo(ctx);
});

bot.action('saldo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showSaldo(ctx);
});

async function showSaldo(ctx) {
  const chatId = getChatId(ctx);
  const balance = await getBalance(chatId);
  const otpBal = await getOtpBalance(chatId);
  await ctx.reply(
    `💳 Ringkasan Saldo Kamu\n━━━━━━━━━━━━━━━━━━\n🖥️ Saldo VPS : ${formatRupiah(balance)}\n📱 Saldo OTP : ${formatRupiah(otpBal)}\n━━━━━━━━━━━━━━━━━━\n\n📦 1 VPS = ${formatRupiah(PRICE)} · Nomor OTP mulai ±Rp1.600 via Saldo OTP.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Isi Saldo (VPS/OTP)', 'topup')],
      [Markup.button.callback(`🛒 Order 1 VPS · ${formatRupiah(PRICE)}`, 'buy_balance')],
    ])
  );
}

// Kirim QR sebagai foto: dukung base64 data URL (qr_image)
// maupun URL http. Buffer dikirim langsung biar Telegram tak perlu fetch.
async function sendQrisPhoto(ctx, qris, order, caption) {
  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Saya Sudah Bayar', `check:${order.id}`)],
    [Markup.button.callback('❌ Batalkan', `cancel:${order.id}`)],
  ]);
  const photoOpts = {
    caption: caption.slice(0, 1000),
    ...buttons,
  };
  let sent = false;
  // qr_image = "data:image/png;base64,...." -> decode langsung
  if (typeof qris.image === 'string' && qris.image.startsWith('data:image')) {
    try {
      const b64 = qris.image.split(',', 2)[1] || '';
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) throw new Error('Gambar kosong');
      await ctx.replyWithPhoto({ source: buf }, photoOpts);
      sent = true;
    } catch {}
  }
  if (!sent && typeof qris.image === 'string' && qris.image.startsWith('data:')) {
    try {
      const b64 = qris.image.split(',', 2)[1] || '';
      const buf = Buffer.from(b64, 'base64');
      if (buf.length) {
        await ctx.replyWithPhoto({ source: buf }, photoOpts);
        sent = true;
      }
    } catch {}
  }
  if (!sent) {
    try {
      const imgRes = await fetch(qris.image);
      if (!imgRes.ok) throw new Error(`Gambar HTTP ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (!buf.length) throw new Error('Gambar kosong');
      await ctx.replyWithPhoto({ source: buf }, photoOpts);
      sent = true;
    } catch {}
  }
  if (!sent) {
    try {
      await ctx.replyWithPhoto({ url: qris.image }, photoOpts);
      sent = true;
    } catch {}
  }
  if (!sent) {
    await ctx.reply(
      `${caption}\n\n⚠️ Gambar QR gagal dimuat. Mohon batalkan pesanan ini lalu buat yang baru untuk QR baru.`,
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
  await withPayLock(getChatId(ctx), async () => {
  try {
    if (!(await isJoinedTesti(ctx.from.id))) {
      await ctx.answerCbQuery('Silakan gabung grup testimoni dulu ya.');
      await ctx.reply(`🔒 Satu langkah lagi — gabung grup testimoni dulu yuk sebelum order:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {});
      return;
    }
    const stock = await readJson(stockFile);
    if (!Array.isArray(stock) || stock.length < 1) return ctx.answerCbQuery('Mohon maaf, stok habis.');
  } catch (e) {
    return ctx.answerCbQuery('Stok belum siap, coba sesaat lagi.');
  }
  try {
    if (await refuseIfPending(ctx, getChatId(ctx))) return;
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
      `✨ Order VPS — Pembayaran QRIS\n━━━━━━━━━━━━━━━━━━\n💰 Total bayar : ${formatRupiah(qris.total)} (sudah termasuk kode unik)\n📷 Scan QR pada foto ini untuk membayar.\n\n` +
      `🧾 Referensi : ${qris.reference}\n` +
      qrisExpiryText(qris);
    await sendQrisPhoto(ctx, qris, order, caption);
    await ctx.answerCbQuery();
  } catch (error) {
    await ctx.answerCbQuery('Gagal membuat QRIS, coba lagi.');
    await ctx.reply(`😔 Maaf, terjadi kendala: ${error.message}`);
  }
  });
});

// ---- Deposit / Top Up Saldo ----
// DUA KANTONG (jangan ketuker):
// - Saldo VPS: buat beli VPS.
// - Saldo OTP: buat beli nokos.
const TOPUP_OPTIONS = [2000, 5000, 10000, 20000, 50000, 100000];
const OTP_TOPUP_OPTIONS = [2000, 5000, 10000, 20000, 50000];

async function getOtpBalance(chatId) {
  try {
    const users = await readJson(usersFile);
    return Number(users?.[chatId]?.nokosBalance || 0);
  } catch {
    return 0;
  }
}

bot.action('topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await isJoinedTesti(ctx.from.id))) {
    await ctx.reply(`🔒 Gabung grup testimoni dulu yuk sebelum isi saldo:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {});
    return;
  }
  await ctx.reply(
    `➕ Isi Saldo\n━━━━━━━━━━━━━━━━━━\nSilakan pilih jenis saldo:\n🖥️ Saldo VPS — untuk order VPS & panel\n📱 Saldo OTP — untuk beli nomor OTP\n━━━━━━━━━━━━━━━━━━`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🖥️ Saldo VPS', 'topup_vps'), Markup.button.callback('📱 Saldo OTP', 'topup_otp')],
    ])
  );
});

bot.action('topup_vps', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(
    `🖥️ Isi Saldo VPS\n━━━━━━━━━━━━━━━━━━\nPilih nominal — saldo masuk otomatis setelah dipotong fee:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Rp2.000', 'topup:2000'), Markup.button.callback('Rp5.000', 'topup:5000')],
      [Markup.button.callback('Rp10.000', 'topup:10000'), Markup.button.callback('Rp20.000', 'topup:20000')],
      [Markup.button.callback('Rp50.000', 'topup:50000'), Markup.button.callback('Rp100.000', 'topup:100000')],
    ])
  );
});

bot.action('topup_otp', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!nokosOn()) { await ctx.reply('😔 Layanan Saldo OTP belum aktif. Silakan hubungi admin.'); return; }
  await ctx.reply(
    `📱 Isi Saldo OTP · min. Rp2.000\n━━━━━━━━━━━━━━━━━━\nDigunakan untuk pembelian nomor OTP.\n⚠️ Saldo OTP bersifat final — isi sesuai kebutuhan ya.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Rp2.000', 'topupotp:2000'), Markup.button.callback('Rp5.000', 'topupotp:5000')],
      [Markup.button.callback('Rp10.000', 'topupotp:10000'), Markup.button.callback('Rp20.000', 'topupotp:20000')],
      [Markup.button.callback('Rp50.000', 'topupotp:50000')],
    ])
  );
});

bot.action(/^topupotp:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await withPayLock(getChatId(ctx), async () => {
  const nominal = Number(ctx.match[1]);
  if (!OTP_TOPUP_OPTIONS.includes(nominal)) return ctx.answerCbQuery('Nominal tidak valid.');
  if (await refuseIfPending(ctx, getChatId(ctx))) return;
  let dep = null;
  try { dep = await createDeposit(nominal, 'qris'); }
  catch (e) { await ctx.reply(`Gagal membuat QRIS: ${e.message}`); return; }
  const chatId = getChatId(ctx);
  const order = {
    id: randomUUID(),
    kind: 'otp_topup',
    chatId,
    buyerName: ctx.from?.first_name || '',
    reference: dep.id,
    createdAt: Date.now(),
    expiredAt: dep.expired_at,
    total: dep.total,
    amount: dep.diterima || nominal,
    status: 'pending',
  };
  const orders = await readJson(ordersFile);
  orders[order.id] = order;
  await writeJson(ordersFile, orders);
  startPolling(order.id);
  const qris = { image: dep.qr_image, reference: dep.id };
  await sendQrisPhoto(ctx, qris, order,
    `📱 Isi Saldo OTP ${formatRupiah(dep.diterima || nominal)}\n━━━━━━━━━━━━━━━━━━\n💰 Total bayar : ${formatRupiah(dep.total)} (termasuk fee)\n📷 Scan QR pada foto ini.\n\n🧾 ID Deposit : ${dep.id}\n${qrisExpiryText({ expiredAt: dep.expired_at })}`);
  });
});

// Kredit saldo OTP yang sudah dibayar via QRIS.
async function creditOtpTopup(orderId) {
  const orders = await readJson(ordersFile);
  const order = orders[orderId];
  if (!order || order.kind !== 'otp_topup' || order.status !== 'pending') return false;
  const users = await readJson(usersFile);
  const u = users[order.chatId] || { balance: 0, nokosBalance: 0 };
  u.nokosBalance = (Number(u.nokosBalance) || 0) + Number(order.amount || 0);
  if (order.buyerName) u.name = order.buyerName;
  users[order.chatId] = u;
  order.status = 'credited';
  order.creditedAt = Date.now();
  await writeJson(usersFile, users);
  await writeJson(ordersFile, orders);
  try {
    await bot.telegram.sendMessage(
      order.chatId,
      `✅ Saldo OTP Bertambah ${formatRupiah(order.amount)}!\n━━━━━━━━━━━━━━━━━━\n📱 Saldo OTP kamu : ${formatRupiah(u.nokosBalance)}\n\nGunakan /nokos untuk beli nomor.`
    );
  } catch {}
  try {
    await notifyAdmins(
      `📱 Topup OTP!\n👤 ${order.buyerName || 'User'} (${order.chatId})\n💰 ${formatRupiah(order.amount)} (bayar ${formatRupiah(order.total)})\n📱 Saldo OTP user: ${formatRupiah(u.nokosBalance)}\nRef: ${order.reference}`
    );
  } catch {}
  try {
    await sendTesti('topup', {
      name: order.buyerName || 'Pembeli',
      detail: 'Top Up Saldo OTP',
      amount: formatRupiah(order.amount),
      ref: order.reference || order.id,
    });
  } catch {}
  return true;
}

async function checkDeposit(order) {
  if (!order?.reference) return false;
  let dep = null;
  try { dep = await depositStatus(order.reference); }
  catch { return false; }
  return depositPaid(dep);
}

bot.action(/^topup:(\d+)$/, async (ctx) => {
  await withPayLock(getChatId(ctx), async () => {
  const nominal = Number(ctx.match[1]);
  if (!TOPUP_OPTIONS.includes(nominal)) return ctx.answerCbQuery('Nominal tidak valid.');
  try {
    if (await refuseIfPending(ctx, getChatId(ctx))) return;
    // Topup saldo VPS masuk via jalur deposit internal (duit parkir di provider, nokos tetap jalan).
    // QRIS langsung VPS/panel tetap via jalur utama (createQris) — tidak berubah.
    let dep = null;
    try { dep = await createDeposit(nominal, 'qris'); }
    catch (e) { await ctx.reply(`Gagal membuat QRIS: ${e.message}`); return; }
    const chatId = getChatId(ctx);
    const order = {
      id: randomUUID(),
      kind: 'topup',
      provider: 'rumahotp',
      chatId,
      buyerName: ctx.from?.first_name || '',
      reference: dep.id,
      createdAt: Date.now(),
      expiredAt: dep.expired_at,
      total: dep.total,
      amount: dep.diterima || nominal,
      status: 'pending',
    };
    const orders = await readJson(ordersFile);
    orders[order.id] = order;
    await writeJson(ordersFile, orders);
    startPolling(order.id);

    const caption =
      `🖥️ Isi Saldo VPS ${formatRupiah(dep.diterima || nominal)}\n━━━━━━━━━━━━━━━━━━\n` +
      `💰 Total bayar : ${formatRupiah(dep.total)} (termasuk fee)\n📷 Scan QR pada foto ini.\n\n` +
      `🧾 ID Deposit : ${dep.id}\n` +
      qrisExpiryText({ expiredAt: dep.expired_at });
    const qris = { image: dep.qr_image, reference: dep.id };
    await sendQrisPhoto(ctx, qris, order, caption);
    await ctx.answerCbQuery();
  } catch (error) {
    await ctx.answerCbQuery('Gagal membuat QRIS, coba lagi.');
    await ctx.reply(`😔 Maaf, terjadi kendala: ${error.message}`);
  }
  });
});

// ---- Beli pakai saldo ----
bot.action('buy_balance', async (ctx) => {
  if (!(await isJoinedTesti(ctx.from.id))) {
    await ctx.answerCbQuery('Silakan gabung grup testimoni dulu ya.');
    await ctx.reply(`🔒 Satu langkah lagi — gabung grup testimoni dulu yuk sebelum order:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {});
    return;
  }
  const chatId = getChatId(ctx);
  const buyerName = ctx.from?.first_name || '';
  const result = await withStockLock(async () => {
    const stock = await readJson(stockFile);
    if (!Array.isArray(stock) || stock.length < 1) return { ok: false, reason: 'habis' };
    const users = await readJson(usersFile);
    const bal = Number(users?.[chatId]?.balance || 0);
    if (bal < PRICE) return { ok: false, reason: 'saldo', bal };
    users[chatId] = { ...(users[chatId] || {}), balance: bal - PRICE, name: buyerName || users[chatId]?.name };
    const vps = stock.splice(0, 1);
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
  if (!result.ok && result.reason === 'habis') return ctx.answerCbQuery('Mohon maaf, stok habis.');
  if (!result.ok && result.reason === 'saldo') {
    await ctx.answerCbQuery('Saldo belum cukup.');
    await ctx.reply(
      `💳 Saldo kamu ${formatRupiah(result.bal)}, belum cukup untuk 1 order (${formatRupiah(PRICE)}). Yuk isi saldo dulu.`,
      Markup.inlineKeyboard([[Markup.button.callback('➕ Isi Saldo Sekarang', 'topup')]])
    );
    return;
  }
  try {
    await ctx.telegram.sendMessage(
      chatId,
      `🎉 VPS Kamu Sudah Aktif!\n_Dibayar dengan saldo_\n━━━━━━━━━━━━━━━━━━\n\n${vpsMessage(result.vps[0], 1)}`
    );
  } catch {}
  await afterBuySuccess(result.order, result.vps);
  await ctx.answerCbQuery('Pembayaran berhasil. Detail VPS dikirim.');
});

// ================= NOKOS (auto-order nomor OTP) =================
// Flow: katalog -> harga termurah ready -> bayar QRIS/saldo
//   -> order nomor -> polling status
//   -> OTP diteruskan ke user. Expired/timeout -> auto cancel (refund).
const nokosTimers = new Map();

function nokosOn() {
  return Boolean(process.env.RUMAHOTP_KEY);
}

async function countActiveNokos(chatId) {
  try {
    const orders = await readJson(ordersFile);
    return Object.values(orders).filter(
      (o) => o && o.chatId === chatId && o.kind === 'nokos' && o.status === 'active'
    ).length;
  } catch { return 0; }
}

// Cek stok nomor cukup? Fail-fast sebelum user bayar.
async function providerReady(butuh) {
  try {
    const b = await otpBalance();
    return { ok: Number(b?.balance || 0) >= Number(butuh || 0), balance: Number(b?.balance || 0) };
  } catch (e) {
    return { ok: false, balance: 0, error: e.message };
  }
}

function nokosButtons(orderId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔁 Kirim Ulang Kode', `nkr:${orderId}`)],
    [Markup.button.callback('✅ Selesai', `nkd:${orderId}`), Markup.button.callback('❌ Batalkan', `nkx:${orderId}`)],
  ]);
}

async function startNokosPoll(orderId) {
  if (nokosTimers.has(orderId)) return;
  const gap = Math.max(10, config.nokosPollSeconds) * 1000;
  const timer = setInterval(() => { pollNokos(orderId).catch(() => {}); }, gap);
  if (typeof timer.unref === 'function') timer.unref();
  nokosTimers.set(orderId, timer);
}

function stopNokosPoll(orderId) {
  const t = nokosTimers.get(orderId);
  if (t) { clearInterval(t); nokosTimers.delete(orderId); }
}

async function pollNokos(orderId) {
  const orders = await readJson(ordersFile);
  const order = orders[orderId];
  if (!order || order.kind !== 'nokos' || order.status !== 'active') { stopNokosPoll(orderId); return; }
  if (Date.now() - order.activatedAt > config.nokosTimeoutMinutes * 60_000) {
    try { await otpSetStatus(order.roOrderId, 'cancel'); } catch {}
    order.status = 'expired';
    await writeJson(ordersFile, orders);
    stopNokosPoll(orderId);
    await bot.telegram.sendMessage(order.chatId, `⏰ Order nomor ${order.phone} kedaluwarsa & dibatalkan otomatis.\n💰 Saldo kamu dikembalikan otomatis.`).catch(() => {});
    return;
  }
  let st = null;
  try { st = await otpStatus(order.roOrderId); }
  catch { return; } // tick berikutnya coba lagi
  const code = extractOtp(st);
  if (code && code !== order.lastCode) {
    order.lastCode = code;
    order.lastRaw = JSON.stringify(st).slice(0, 500);
    await writeJson(ordersFile, orders);
    await bot.telegram.sendMessage(
      order.chatId,
      `📩 Kode OTP Masuk!\n━━━━━━━━━━━━━━━━━━\n📱 ${order.phone} · ${order.serviceLabel}\n🔑 Kode : \`${code}\`\n━━━━━━━━━━━━━━━━━━\n${order.lastRaw || ''}`,
      { parse_mode: 'Markdown', ...nokosButtons(order.id) }
    ).catch(() => {});
  }
}

// Dipanggil setelah QRIS/saldo lunas untuk order nokos_pending:
// ambil nomor beneran, kirim ke user.
async function activateNokos(orderId) {
  const orders = await readJson(ordersFile);
  const order = orders[orderId];
  if (!order || order.kind !== 'nokos_pending' || order.status !== 'pending') return false;
  if ((await countActiveNokos(order.chatId)) >= config.nokosMaxActive) {
    await bot.telegram.sendMessage(order.chatId, `🔒 Gagal aktivasi: kamu sudah mencapai batas ${config.nokosMaxActive} nomor aktif.`).catch(() => {});
    order.status = 'cancelled';
    await writeJson(ordersFile, orders);
    return false;
  }
  let ro = null;
  try {
    ro = await createOrderV2(order.numberId, order.providerId, order.operatorId);
  } catch (e) {
    order.status = 'failed';
    order.failReason = e.message;
    await writeJson(ordersFile, orders);
    // User SUDAH bayar (QRIS lunas / saldo kepotong) tapi ambil nomor gagal:
    // refund otomatis ke saldo bot biar user ga rugi, admin tinggal beresin.
    if (order.payMethod === 'qris') {
      try {
        const users = await readJson(usersFile);
        const u = users[order.chatId] || { balance: 0 };
        u.balance = (Number(u.balance) || 0) + Number(order.total || 0);
        if (order.buyerName) u.name = order.buyerName;
        users[order.chatId] = u;
        await writeJson(usersFile, users);
        order.refunded = Number(order.total || 0);
        await writeJson(ordersFile, orders);
      } catch {}
    }
    await bot.telegram.sendMessage(order.chatId, `😔 Gagal mengambil nomor: ${e.message}\n${order.payMethod === 'qris' ? `💰 ${formatRupiah(order.total)} otomatis dikembalikan menjadi saldo bot kamu. Cek /saldo.` : `💰 Saldo kamu aman, tidak terpotong.`}\n🧾 Simpan referensi: ${order.reference || order.id}`).catch(() => {});
    await notifyAdmins(`🚨 NOKOS GAGAL\n👤 ${order.buyerName} (${order.chatId})\n📦 ${order.serviceLabel || ''} ${order.countryLabel || ''}\n💰 ${formatRupiah(order.total)} (${order.payMethod}) — gagal ambil nomor: ${e.message}\n${order.payMethod === 'qris' ? '✅ Auto-refund ke saldo bot user.' : 'Saldo user aman (belum dipotong).'}\nRef: ${order.reference || order.id}`);
    return false;
  }
  order.kind = 'nokos';
  order.status = 'active';
  order.roOrderId = ro.order_id;
  order.phone = ro.phone_number;
  order.activatedAt = Date.now();
  order.lastCode = null;
  await writeJson(ordersFile, orders);
  startNokosPoll(order.id);
  await bot.telegram.sendMessage(
    order.chatId,
    `📱 Nomor Kamu Sudah Aktif!\n━━━━━━━━━━━━━━━━━━\n📦 ${order.serviceLabel} · ${order.countryLabel || 'Indonesia'}\n📞 Nomor : \`${order.phone}\`\n🆔 Order : ${order.roOrderId}\n⏰ Aktif ${config.nokosTimeoutMinutes} menit · kode OTP diteruskan otomatis ke sini.\n\nMasukkan nomor ini di aplikasi, lalu tunggu kodenya masuk.`,
    { parse_mode: 'Markdown', ...nokosButtons(order.id) }
  ).catch(() => {});
  try {
    await notifyAdmins(`📱 Nokos laku!\n👤 ${order.buyerName} (${order.chatId})\n📦 ${order.serviceLabel} ${order.phone}\n💰 ${formatRupiah(order.total)} via ${order.payMethod === 'balance' ? 'SALDO' : 'QRIS'}\nRef: ${order.reference || order.id}`);
  } catch {}
  try {
    await sendTesti('buy', {
      name: order.buyerName || 'Pembeli',
      detail: `Nokos ${order.serviceLabel || ''} ${order.phone || ''}`.trim(),
      amount: formatRupiah(order.total),
      ref: order.reference || order.id,
    });
  } catch {}
  return true;
}

const NOKOS_PAGE = 8; // tombol per halaman browser

async function nokosActiveList(chatId) {
  try {
    const orders = await readJson(ordersFile);
    return Object.values(orders).filter((o) => o && o.chatId === chatId && o.kind === 'nokos' && o.status === 'active');
  } catch { return []; }
}

async function serviceLabel(serviceId) {
  const fav = NOKOS_CATALOG.find((s) => s.serviceId === Number(serviceId));
  if (fav) return `${fav.emoji} ${fav.label}`;
  try {
    const all = await cachedServices();
    const hit = (all || []).find((s) => String(s.service_code) === String(serviceId));
    if (hit) return hit.service_name;
  } catch {}
  return `Service ${serviceId}`;
}

function countryCheapest(row) {
  const list = (row?.pricelist || []).filter((p) => p.available !== false && Number(p.stock) > 0);
  if (!list.length) return null;
  return list.reduce((a, b) => (Number(a.price) <= Number(b.price) ? a : b));
}

function nokosFavRows() {
  return NOKOS_CATALOG.map((s) => [Markup.button.callback(`${s.emoji} ${s.label} — Indo (cepat)`, `nk:${s.serviceId}`)]);
}

bot.command('nokos', async (ctx) => {
  if (!nokosOn()) { await ctx.reply('😔 Layanan nomor OTP belum aktif. Silakan hubungi admin.'); return; }
  const mine = await nokosActiveList(getChatId(ctx));
  await ctx.reply(
    `📱 Nomor OTP Premium — Semua Layanan & Negara\n━━━━━━━━━━━━━━━━━━\n🟢 Order aktif kamu : ${mine.length}/${config.nokosMaxActive}\n${mine.map((o) => `• ${o.serviceLabel} · ${o.phone}`).join('\n')}\n━━━━━━━━━━━━━━━━━━\n\nPilih jalur cepat atau jelajahi katalog lengkap:`,
    Markup.inlineKeyboard([...nokosFavRows(), [Markup.button.callback('🔍 Semua layanan', 'nks:0')]])
  );
});

bot.action('nokos', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!nokosOn()) { await ctx.reply('😔 Layanan nomor OTP belum aktif.'); return; }
  if (!(await isJoinedTesti(ctx.from.id))) {
    await ctx.reply(`🔒 Gabung grup testimoni dulu yuk:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {});
    return;
  }
  const mine = await nokosActiveList(getChatId(ctx));
  await ctx.reply(
    `📱 Nomor OTP (aktif: ${mine.length}/${config.nokosMaxActive})\nPilih jalur cepat atau jelajahi katalog lengkap:`,
    Markup.inlineKeyboard([...nokosFavRows(), [Markup.button.callback('🔍 Semua layanan', 'nks:0')]])
  );
});

// ---- Browser services (paging, ratusan service) ----
bot.action(/^nks:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const page = Math.max(0, Number(ctx.match[1]) || 0);
  let all = [];
  try { all = await cachedServices(); }
  catch (e) { await ctx.reply(`Gagal memuat layanan: ${e.message}`); return; }
  const total = Math.max(1, Math.ceil(all.length / NOKOS_PAGE));
  const p = Math.min(page, total - 1);
  const slice = all.slice(p * NOKOS_PAGE, p * NOKOS_PAGE + NOKOS_PAGE);
  const rows = slice.map((s) => [Markup.button.callback(`📦 ${s.service_name}`, `nsvc:${s.service_code}:0`)]);
  const nav = [];
  if (p > 0) nav.push(Markup.button.callback('◀️', `nks:${p - 1}`));
  nav.push(Markup.button.callback(`${p + 1}/${total}`, 'nokos_noop'));
  if (p < total - 1) nav.push(Markup.button.callback('▶️', `nks:${p + 1}`));
  rows.push(nav);
  await ctx.reply(`🔍 Katalog Layanan (${all.length}) · hal. ${p + 1}/${total}:`, Markup.inlineKeyboard(rows));
});

bot.action('nokos_noop', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); });

// ---- Browser negara per service (Indo paling atas, sisanya termurah dulu) ----
bot.action(/^nsvc:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serviceId = Number(ctx.match[1]);
  const page = Math.max(0, Number(ctx.match[2]) || 0);
  let rows = [];
  try { rows = await cachedCountries(serviceId); }
  catch (e) { await ctx.reply(`Gagal memuat daftar negara: ${e.message}`); return; }
  const label = await serviceLabel(serviceId);
  const withPrice = (rows || []).map((r) => ({ r, cheap: countryCheapest(r) })).filter((x) => x.cheap);
  withPrice.sort((a, b) => {
    const ai = /indonesia/i.test(a.r.name || '') ? 0 : 1;
    const bi = /indonesia/i.test(b.r.name || '') ? 0 : 1;
    return ai - bi || Number(a.cheap.price) - Number(b.cheap.price);
  });
  if (!withPrice.length) { await ctx.reply(`😔 ${label}: semua negara sedang kosong. Coba lagi nanti.`); return; }
  const total = Math.max(1, Math.ceil(withPrice.length / NOKOS_PAGE));
  const p = Math.min(page, total - 1);
  const slice = withPrice.slice(p * NOKOS_PAGE, p * NOKOS_PAGE + NOKOS_PAGE);
  const kb = slice.map(({ r, cheap }) => [Markup.button.callback(
    `${/indonesia/i.test(r.name || '') ? '🇮🇩' : '🌍'} ${r.name} — ${formatRupiah(sellPrice(cheap.price))} (stok ${r.stock_total})`,
    `nky:${serviceId}:${r.number_id}`
  )]);
  const nav = [];
  if (p > 0) nav.push(Markup.button.callback('◀️', `nsvc:${serviceId}:${p - 1}`));
  nav.push(Markup.button.callback(`${p + 1}/${total}`, 'nokos_noop'));
  if (p < total - 1) nav.push(Markup.button.callback('▶️', `nsvc:${serviceId}:${p + 1}`));
  kb.push(nav);
  await ctx.reply(`🌍 ${label} — pilih negara (hal. ${p + 1}/${total}, termurah dulu):`, Markup.inlineKeyboard(kb));
});

// ---- Pilih nomor per negara (termurah dulu, top 8) ----
bot.action(/^nky:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const serviceId = Number(ctx.match[1]);
  const numberId = Number(ctx.match[2]);
  let rows = [];
  try { rows = await cachedCountries(serviceId); }
  catch (e) { await ctx.reply(`Gagal memuat stok: ${e.message}`); return; }
  const row = (rows || []).find((r) => Number(r.number_id) === numberId);
  if (!row) { await ctx.reply('Negara tidak ditemukan.'); return; }
  const label = await serviceLabel(serviceId);
  const list = (row.pricelist || []).filter((p) => p.available !== false && Number(p.stock) > 0);
  list.sort((a, b) => Number(a.price) - Number(b.price));
  if (!list.length) { await ctx.reply('😔 Nomor negara ini sedang kosong.'); return; }
  const kb = list.slice(0, NOKOS_PAGE).map((p) => [Markup.button.callback(
    `💰 ${formatRupiah(sellPrice(p.price))} — stok ${p.stock} (server ${p.server_id})`,
    `nkp:${serviceId}:${numberId}:${p.provider_id}`
  )]);
  await ctx.reply(`🏭 ${label} · ${row.name} (${row.prefix})\nSilakan pilih (termurah dulu):`, Markup.inlineKeyboard(kb));
});

bot.action(/^nk:(\d+)$/, async (ctx) => {
  await showNokosDetail(ctx, Number(ctx.match[1]), null, null, false);
});

bot.action(/^nkrf:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery('Refresh harga...').catch(() => {});
  await showNokosDetail(ctx, Number(ctx.match[1]), null, null, true);
});

bot.action(/^nkp:(\d+):(\d+):([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showNokosDetail(ctx, Number(ctx.match[1]), Number(ctx.match[2]), String(ctx.match[3]), false);
});

async function showNokosDetail(ctx, serviceId, numberId, providerId, force) {
  let meta = null;
  try { meta = await prepareNokosMeta(serviceId, numberId, providerId, force); }
  catch (e) { await ctx.reply(`😔 Maaf, terjadi kendala: ${e.message}`); return; }
  const tag = `${meta.label} — ${meta.row.name} (${meta.row.prefix})`;
  await ctx.reply(
    `📱 ${tag}\n━━━━━━━━━━━━━━━━━━\n` +
    `📦 Stok tersedia : ${meta.best.stock}\n` +
    `💰 Harga : ${formatRupiah(meta.jual)}\n` +
    `⏰ Masa aktif ${config.nokosTimeoutMinutes} mnt · kode OTP diteruskan otomatis.${force ? '\n🔄 Harga diperbarui.' : ''}\n━━━━━━━━━━━━━━━━━━\n\nPilih metode pembayaran:`,
    Markup.inlineKeyboard([
      [Markup.button.callback(`🛒 QRIS ${formatRupiah(meta.jual)}`, `nbuy:${serviceId}:${meta.row.number_id}:${meta.best.provider_id}`)],
      [Markup.button.callback(`💰 Saldo ${formatRupiah(meta.jual)}`, `nbuybal:${serviceId}:${meta.row.number_id}:${meta.best.provider_id}`)],
      [Markup.button.callback('🔄 Refresh harga', `nkrfp:${serviceId}:${meta.row.number_id}:${meta.best.provider_id}`)],
    ])
  );
}

bot.action(/^nkrfp:(\d+):(\d+):([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery('Refresh harga...').catch(() => {});
  await showNokosDetail(ctx, Number(ctx.match[1]), Number(ctx.match[2]), String(ctx.match[3]), true);
});

async function prepareNokosMeta(serviceId, numberId = null, providerId = null, force = true) {
  const label = await serviceLabel(serviceId);
  const rows = await cachedCountries(serviceId, force); // fresh pas bayar/detail-refresh
  let row = null;
  if (numberId) row = (rows || []).find((r) => Number(r.number_id) === Number(numberId));
  else row = (rows || []).find((r) => r.iso_code === 'id' || /indonesia/i.test(r.name || ''));
  if (!row) throw new Error('Negara tidak tersedia.');
  let best = null;
  if (providerId) {
    best = (row.pricelist || []).find((p) => String(p.provider_id) === String(providerId) && p.available !== false && Number(p.stock) > 0);
    if (!best) throw new Error('Nomor itu baru aja habis. Balik & pilih lain.');
  } else {
    best = cheapestProvider(row);
  }
  if (!best) throw new Error('Stok kosong.');
  let operatorId = 1; // 'any' default
  try {
    const ops = await operatorsV2(row.name || 'indonesia', best.provider_id);
    const any = (ops || []).find((o) => String(o.name).toLowerCase() === 'any');
    operatorId = any ? any.id : (ops?.[0]?.id ?? 1);
  } catch {} // fallback any
  return { label, row, best, operatorId, jual: sellPrice(best.price) };
}

function parseBuyArgs(m) {
  return {
    serviceId: Number(m[1]),
    numberId: m[2] ? Number(m[2]) : null,
    providerId: m[3] ? String(m[3]) : null,
  };
}

bot.action(/^nbuy:(\d+)(?::(\d+):([^:]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await isJoinedTesti(ctx.from.id))) { await ctx.reply(`🔒 Gabung grup kami dulu yuk:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {}); return; }
  if ((await countActiveNokos(getChatId(ctx))) >= config.nokosMaxActive) {
    await ctx.reply(`🔒 Kamu sudah mencapai batas ${config.nokosMaxActive} nomor aktif. Selesaikan atau batalkan dulu ya.`);
    return;
  }
  await withPayLock(getChatId(ctx), async () => {
  const args = parseBuyArgs(ctx.match);
  let meta = null;
  try { meta = await prepareNokosMeta(args.serviceId, args.numberId, args.providerId); }
  catch (e) { await ctx.reply(`😔 Maaf, terjadi kendala: ${e.message}`); return; }
  const ready = await providerReady(meta.best.price);
  if (!ready.ok) {
    await ctx.reply(`😔 Stok nomor sedang habis. Mohon jangan bayar dulu — hubungi admin ya.`);
    await notifyAdmins(`⚠️ NOKOS DITAHAN (QRIS)\n👤 ${ctx.from?.first_name} (${getChatId(ctx)}) mau beli ${meta.label} ${meta.row.name} ${formatRupiah(meta.jual)}.\nStok nomor habis — cek dashboard.`);
    return;
  }
  let qris = null;
  if (await refuseIfPending(ctx, getChatId(ctx))) return;
  try { qris = await createQris(meta.jual); }
  catch (e) { await ctx.reply(`Gagal membuat QRIS: ${e.message}`); return; }
  const chatId = getChatId(ctx);
  const order = {
    id: randomUUID(), kind: 'nokos_pending', payMethod: 'qris',
    chatId, buyerName: ctx.from?.first_name || '',
    reference: qris.reference, createdAt: Date.now(), expiredAt: qris.expiredAt,
    total: qris.total, amount: qris.nominal, status: 'pending',
    serviceId: args.serviceId, serviceLabel: meta.label,
    countryLabel: meta.row.name || 'Indonesia',
    numberId: meta.row.number_id, providerId: String(meta.best.provider_id), operatorId: meta.operatorId,
    modal: meta.best.price, jual: meta.jual,
  };
  const orders = await readJson(ordersFile);
  orders[order.id] = order;
  await writeJson(ordersFile, orders);
  startPolling(order.id);
  await sendQrisPhoto(ctx, qris, order,
    `📱 Nomor ${meta.label} · ${meta.row.name}\n━━━━━━━━━━━━━━━━━━\n💰 Total bayar : ${formatRupiah(qris.total)}\n📷 Scan QR pada foto ini.\n✨ Nomor dipesan OTOMATIS setelah pembayaran.\n\n🧾 Referensi : ${qris.reference}\n${qrisExpiryText(qris)}`);
  });
});

bot.action(/^nbuybal:(\d+)(?::(\d+):([^:]+))?$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!(await isJoinedTesti(ctx.from.id))) { await ctx.reply(`🔒 Gabung grup kami dulu yuk:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {}); return; }
  const chatId = getChatId(ctx);
  const args = parseBuyArgs(ctx.match);
  let meta = null;
  try { meta = await prepareNokosMeta(args.serviceId, args.numberId, args.providerId); }
  catch (e) { await ctx.reply(`😔 Maaf, terjadi kendala: ${e.message}`); return; }
  const users = await readJson(usersFile);
  const bal = Number(users?.[chatId]?.nokosBalance || 0);
  if (bal < meta.jual) {
    await ctx.reply(`📱 Saldo OTP kamu ${formatRupiah(bal)}, dibutuhkan ${formatRupiah(meta.jual)}. Yuk isi Saldo OTP dulu.`, Markup.inlineKeyboard([[Markup.button.callback('📱 Isi Saldo OTP', 'topup_otp')]]));
    return;
  }
  if ((await countActiveNokos(chatId)) >= config.nokosMaxActive) {
    await ctx.reply(`🔒 Batas ${config.nokosMaxActive} nomor aktif tercapai.`);
    return;
  }
  // Cek stok nomor dulu — jangan potong user kalau stok habis.
  const ready = await providerReady(meta.best.price);
  if (!ready.ok) {
    await ctx.reply(`😔 Stok nomor sedang habis.\n💰 Saldo kamu aman, tidak terpotong. Silakan hubungi admin.`);
    await notifyAdmins(`⚠️ NOKOS DITAHAN\n👤 ${ctx.from?.first_name} (${chatId}) mau beli ${meta.label} ${meta.row.name} ${formatRupiah(meta.jual)}.\nStok nomor habis — cek dashboard.`);
    return;
  }
  // Ambil nomor DULU, potong saldo user KALAU sukses. Urutan ini anti-rugi.
  let ro = null;
  try {
    ro = await createOrderV2(meta.row.number_id, String(meta.best.provider_id), meta.operatorId);
  } catch (e) {
    await ctx.reply(`😔 Gagal mengambil nomor: ${e.message}\n💰 Saldo kamu aman, tidak terpotong.`);
    await notifyAdmins(`🚨 NOKOS GAGAL (saldo user aman)\n👤 ${ctx.from?.first_name} (${chatId})\n📦 ${meta.label} ${meta.row.name} — gagal ambil nomor: ${e.message}`);
    return;
  }
  users[chatId] = { ...(users[chatId] || {}), nokosBalance: bal - meta.jual, name: ctx.from?.first_name || users[chatId]?.name };
  const order = {
    id: randomUUID(), kind: 'nokos', payMethod: 'balance',
    chatId, buyerName: ctx.from?.first_name || '',
    reference: null, createdAt: Date.now(), activatedAt: Date.now(), total: meta.jual, status: 'active',
    serviceId: args.serviceId, serviceLabel: meta.label,
    countryLabel: meta.row.name || 'Indonesia',
    numberId: meta.row.number_id, providerId: String(meta.best.provider_id), operatorId: meta.operatorId,
    modal: meta.best.price, jual: meta.jual,
    roOrderId: ro.order_id, phone: ro.phone_number, lastCode: null,
  };
  const orders = await readJson(ordersFile);
  orders[order.id] = order;
  await writeJson(usersFile, users);
  await writeJson(ordersFile, orders);
  startNokosPoll(order.id);
  await ctx.reply(
    `📱 Nomor Kamu Sudah Aktif!\n━━━━━━━━━━━━━━━━━━\n📦 ${meta.label} · ${meta.row.name || 'Indonesia'}\n📞 Nomor : \`${ro.phone_number}\`\n🆔 Order : ${ro.order_id}\n💳 Terpotong : ${formatRupiah(meta.jual)} (Saldo OTP)\n⏰ Aktif ${config.nokosTimeoutMinutes} menit · kode OTP diteruskan otomatis ke sini.`,
    { parse_mode: 'Markdown', ...nokosButtons(order.id) }
  );
  try {
    await notifyAdmins(`📱 Nokos laku!\n👤 ${order.buyerName} (${chatId})\n📦 ${meta.label} ${ro.phone_number}\n💰 ${formatRupiah(meta.jual)} via SALDO\nRef: ${order.id.slice(0, 8)}`);
  } catch {}
  try {
    await sendTesti('buy', {
      name: order.buyerName || 'Pembeli',
      detail: `Nokos ${meta.label} ${ro.phone_number}`.trim(),
      amount: formatRupiah(meta.jual),
      ref: order.id,
    });
  } catch {}
});

bot.action(/^nkd:(.+)$/, async (ctx) => {
  const orders = await readJson(ordersFile);
  const order = orders[ctx.match[1]];
  if (!order || order.chatId !== getChatId(ctx)) return ctx.answerCbQuery('Order tidak ditemukan.');
  try { await otpSetStatus(order.roOrderId, 'done'); } catch {}
  order.status = 'done';
  await writeJson(ordersFile, orders);
  stopNokosPoll(order.id);
  await ctx.answerCbQuery('Order ditandai selesai. Terima kasih!');
  await ctx.reply(`✅ Order nomor ${order.phone} selesai. Terima kasih banyak atas orderannya! 🙏`);
});

bot.action(/^nkr:(.+)$/, async (ctx) => {
  const orders = await readJson(ordersFile);
  const order = orders[ctx.match[1]];
  if (!order || order.chatId !== getChatId(ctx)) return ctx.answerCbQuery('Order tidak ditemukan.');
  try { await otpSetStatus(order.roOrderId, 'resend'); await ctx.answerCbQuery('Permintaan kirim ulang terkirim.'); }
  catch (e) { await ctx.answerCbQuery('Gagal meminta kirim ulang.'); }
});

bot.action(/^nkx:(.+)$/, async (ctx) => {
  const orders = await readJson(ordersFile);
  const order = orders[ctx.match[1]];
  if (!order || order.chatId !== getChatId(ctx)) return ctx.answerCbQuery('Order tidak ditemukan.');
  try { await otpSetStatus(order.roOrderId, 'cancel'); } catch {}
  order.status = 'cancelled';
  await writeJson(ordersFile, orders);
  stopNokosPoll(order.id);
  await ctx.answerCbQuery('Order dibatalkan. Saldo kembali otomatis.');
  await ctx.reply(`❌ Order nomor ${order.phone} dibatalkan. Saldo dikembalikan otomatis.`);
});

bot.command('nokosaldo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  try {
    const b = await otpBalance();
    await ctx.reply(`📱 Saldo stok nomor: ${b.formated || formatRupiah(b.balance)}\nUser: ${b.username || '-'}`);
  } catch (e) { await ctx.reply(`Gagal cek stok nomor: ${e.message}`); }
});

bot.action(/^check:(.+)$/, async (ctx) => {
  try {
    await verifyAndDeliver(ctx, ctx.match[1]);
  } catch (error) {
    await ctx.answerCbQuery('Gagal mengecek pembayaran.');
    await ctx.reply(`😔 Maaf, terjadi kendala: ${error.message}`);
  }
});

bot.action(/^cancel:(.+)$/, async (ctx) => {
  try {
    const orders = await readJson(ordersFile);
    const order = orders[ctx.match[1]];
    const chatId = getChatId(ctx);
    if (!order || (chatId && order.chatId !== chatId)) return ctx.answerCbQuery('Pesanan tidak ditemukan.');
    if (order.status === 'delivered' || order.status === 'credited' || order.status === 'paid_panel') return ctx.answerCbQuery('Sudah diproses, tidak dapat dibatalkan.');
    if (order.status === 'cancelled') return ctx.answerCbQuery('Pesanan ini sudah dibatalkan.');
    if (!order.reference) return ctx.answerCbQuery('Pesanan via saldo tidak dapat dibatalkan.');
    // Kalau ternyata sudah bayar, proses daripada dibatalkan
    try {
      const alreadyPaid = (order.kind === 'otp_topup' || order.provider === 'rumahotp') ? await checkDeposit(order) : await checkPayment(order);
      if (alreadyPaid) {
        await verifyAndDeliver(ctx, order.id);
        return;
      }
    } catch {}
    try {
      if (order.kind === 'otp_topup' || order.provider === 'rumahotp') {
        if (order.reference) await cancelDeposit(order.reference).catch(() => {});
      } else {
        await cancelPayment(order);
      }
    } catch (e) {
      await ctx.answerCbQuery('Gagal membatalkan.');
      await ctx.reply(`Gagal membatalkan: ${e.message}`).catch(() => {});
      return;
    }
    order.status = 'cancelled';
    await writeJson(ordersFile, orders);
    stopPolling(order.id);
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    } catch {}
    await ctx.answerCbQuery('Pesanan dibatalkan.');
    await ctx.reply('❌ Pesanan dibatalkan. Kapan pun siap, buat pesanan baru via /start ya.').catch(() => {});
  } catch (error) {
    await ctx.answerCbQuery('Gagal membatalkan.');
    await ctx.reply(`😔 Maaf, terjadi kendala: ${error.message}`).catch(() => {});
  }
});

bot.action('cek_join', async (ctx) => {
  const joined = await isJoinedTesti(ctx.from.id);
  if (!joined) {
    await ctx.answerCbQuery('Belum terdeteksi — gabung dulu ya.');
    await ctx.reply(
      `🔍 Kami belum mendeteksi kamu bergabung.\nSilakan gabung dulu: 👉 ${config.testiLink}\nLalu tekan tombol di bawah sekali lagi.`,
      joinGateButtons()
    ).catch(() => {});
    return;
  }
  await ctx.answerCbQuery('✅ Terima kasih sudah bergabung!');
  const name = ctx.from?.first_name || 'Kak';
  const { text, buttons } = await buildStart(name, getChatId(ctx));
  const photo = await specPhoto();
  if (photo) {
    const remaining = await getStockCount();
    const balance = await getBalance(getChatId(ctx));
    const otpBal = await getOtpBalance(getChatId(ctx));
    const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
    const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
    const dot = remaining < 1 ? '🔴' : percent < 30 ? '🟡' : '🟢';
    await ctx.replyWithPhoto({ source: photo }, {
      caption: menuCaption(name, balance, otpBal, remaining, total, percent, dot, remaining < 1),
      ...buttons,
    }).catch(async () => { await ctx.reply(text, buttons); });
    return;
  }
  await ctx.reply(text, buttons);
});

// ---- Contact Admin ----
// User: pencet tombol / ketik /contact -> kirim pesan/foto -> diteruskan ke semua admin.
// Admin balas: /balas <id_user> <pesan>
const pendingContact = new Set();

bot.action('contact_help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  pendingContact.add(String(ctx.from.id));
  await ctx.reply(
    `💬 Hubungi Admin\n━━━━━━━━━━━━━━━━━━\n` +
    `Ketik /contact lalu tulis pesanmu, atau langsung kirim di sini:\n` +
    `• Teks, foto, video, dokumen, voice note — semua bisa\n\n` +
    `Contoh: /contact VPS saya tidak konek, IP 1.2.3.4\n\n` +
    `Admin akan membalas langsung lewat bot ini. 🙏`
  );
});

bot.command('contact', async (ctx) => {
  const text = (ctx.message?.text || '').replace(/^\/contact(@\w+)?/, '').trim();
  const reply = ctx.message?.reply_to_message;
  if (text || reply?.photo || reply?.video || reply?.document || reply?.animation || reply?.voice) {
    await forwardToAdmins(ctx, text, reply);
    return;
  }
  pendingContact.add(String(ctx.from.id));
  await ctx.reply('✍️ Silakan tulis pesan / kirim foto kendalamu sekarang. Admin akan membalas lewat bot ini.');
});

// Pesan non-command dari user yang lagi mode contact -> teruskan ke admin
bot.on(['text', 'photo', 'video', 'document', 'animation', 'voice'], async (ctx, next) => {
  try {
    const uid = String(ctx.from?.id || '');
    if (ctx.chat?.type !== 'private' || !pendingContact.has(uid)) return next();
    const txt = ctx.message?.text || ctx.message?.caption || '';
    if (txt.startsWith('/')) return next(); // command lain, lewatkan
    pendingContact.delete(uid);
    await forwardToAdmins(ctx, txt, null);
  } catch { try { await next(); } catch {} }
});

async function forwardToAdmins(ctx, text, replyMsg) {
  const uid = String(ctx.from?.id || '');
  const name = ctx.from?.first_name || 'User';
  const uname = ctx.from?.username ? `@${ctx.from.username}` : '(no username)';
  pendingContact.delete(uid);
  if (!config.adminIds.length) {
    await ctx.reply('😔 Admin belum tersedia. Silakan coba lagi nanti.');
    return;
  }
  const header = `🆘 PESAN USER\n👤 ${name} ${uname}\n🆔 ${uid}\n━━━━━━━━━━━━`;
  let sent = 0;
  for (const aid of config.adminIds) {
    try {
      if (ctx.message?.photo) {
        const fid = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await bot.telegram.sendPhoto(aid, fid, { caption: `${header}\n${text || ctx.message?.caption || ''}\n\nBalas: /balas ${uid} pesan kamu`.slice(0, 1000) });
      } else if (ctx.message?.video) {
        await bot.telegram.sendVideo(aid, ctx.message.video.file_id, { caption: `${header}\n${text || ''}\n\nBalas: /balas ${uid} pesan kamu`.slice(0, 1000) });
      } else if (ctx.message?.document) {
        await bot.telegram.sendDocument(aid, ctx.message.document.file_id, { caption: `${header}\n${text || ''}\n\nBalas: /balas ${uid} pesan kamu`.slice(0, 1000) });
      } else if (ctx.message?.voice) {
        await bot.telegram.sendVoice(aid, ctx.message.voice.file_id, { caption: `${header}\nBalas: /balas ${uid} pesan kamu`.slice(0, 1000) });
        if (text) await bot.telegram.sendMessage(aid, `${header}\n${text}\n\nBalas: /balas ${uid} pesan kamu`);
      } else if (replyMsg?.photo) {
        const fid = replyMsg.photo[replyMsg.photo.length - 1].file_id;
        await bot.telegram.sendPhoto(aid, fid, { caption: `${header}\n${text || replyMsg.caption || ''}\n\nBalas: /balas ${uid} pesan kamu`.slice(0, 1000) });
      } else {
        await bot.telegram.sendMessage(aid, `${header}\n${text || '(pesan kosong)'}\n\nBalas: /balas ${uid} pesan kamu`);
      }
      sent++;
    } catch (e) { console.error(`Gagal forward ke admin ${aid}:`, e.message); }
  }
  if (sent) await ctx.reply('✅ Pesan terkirim ke admin. Mohon tunggu balasannya di sini ya! 🙏');
  else await ctx.reply('😔 Gagal mengirim ke admin. Silakan coba lagi nanti.');
}

// ---- Panel Legal ----
bot.action('panel_legal', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(panelIntroText(), panelListKeyboard());
  } catch {
    await ctx.answerCbQuery('Gagal buka menu panel.').catch(() => {});
  }
});

// User klik paket -> minta username (dikunci anti-QR-ganda kayak order lain)
bot.action(/^pbuy:(.+)$/, async (ctx) => {
  const plan = panelPlanById(ctx.match[1]);
  if (!plan) return ctx.answerCbQuery('Paket tidak valid.');
  const chatId = getChatId(ctx);
  const dup = await findPendingPayment(chatId);
  if (dup) {
    await ctx.answerCbQuery('Kamu masih memiliki QR aktif.').catch(() => {});
    await ctx.reply(`⏳ Selesaikan pembayaran QR sebelumnya dulu (ref: ${dup.reference}) atau batalkan sebelum membuat yang baru.`).catch(() => {});
    return;
  }
  await withPayLock(chatId, async () => {
    panelWaitUsername.set(String(chatId), plan.id);
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply(
      `📦 Panel ${plan.label} · ${formatRupiah(plan.price)}\n━━━━━━━━━━━━━━━━━━\n\nSilakan kirim USERNAME panel yang kamu inginkan (1 pesan, tanpa spasi, contoh: nagato01).\n\nKetik /batal kapan saja untuk membatalkan.`,
      Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'panel_cancel_input')]])
    );
  });
});

bot.action('panel_cancel_input', async (ctx) => {
  panelWaitUsername.delete(String(getChatId(ctx)));
  pendingPanelPay.delete(String(getChatId(ctx)));
  await ctx.answerCbQuery('Dibatalkan.').catch(() => {});
  await ctx.reply('❌ Input username dibatalkan. Kembali ke /start kapan pun kamu siap.');
});

bot.command('batal', async (ctx) => {
  panelWaitUsername.delete(String(getChatId(ctx)));
  pendingPanelPay.delete(String(getChatId(ctx)));
  await ctx.reply('❌ Dibatalkan. Kembali ke /start kapan pun kamu siap.');
});

// Tangkap username -> buatkan QRIS sesuai harga paket
bot.on('text', async (ctx, next) => {
  try {
    const chatKey = String(getChatId(ctx));
    const text = (ctx.message?.text || '').trim();
    if (text.startsWith('/')) return next();
    if (!panelWaitUsername.has(chatKey)) return next();
    const plan = panelPlanById(panelWaitUsername.get(chatKey));
    if (!plan) {
      panelWaitUsername.delete(chatKey);
      return next();
    }
    const username = text.split(/\s+/)[0].slice(0, 32);
    if (!/^[a-zA-Z0-9_.]{3,32}$/.test(username)) {
      await ctx.reply('❌ Username 3–32 karakter, huruf/angka/underscore/titik saja. Kirim ulang, atau /batal.');
      return;
    }
    panelWaitUsername.delete(chatKey);
    const balance = await getBalance(getChatId(ctx));
    pendingPanelPay.set(chatKey, { planId: plan.id, username });
    await ctx.reply(
      `📦 Panel ${plan.label}\n━━━━━━━━━━━━━━━━━━\n👤 Username : ${username}\n💳 Saldo kamu : ${formatRupiah(balance)}\n💰 Harga : ${formatRupiah(plan.price)}\n━━━━━━━━━━━━━━━━━━\n\nPilih metode pembayaran:`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`📷 Bayar via QRIS · ${formatRupiah(plan.price)}`, 'ppay:qris')],
        [Markup.button.callback(`💳 Bayar via Saldo · ${formatRupiah(plan.price)}`, 'ppay:saldo')],
        [Markup.button.callback('❌ Batal', 'panel_cancel_input')],
      ])
    );
  } catch { try { await next(); } catch {} }
});

// ---- Eksekusi bayar panel: QRIS vs Saldo ----
bot.action('ppay:qris', async (ctx) => {
  const chatKey = String(getChatId(ctx));
  const pend = pendingPanelPay.get(chatKey);
  if (!pend) return ctx.answerCbQuery('Pilihan kedaluwarsa. Ulangi dari menu panel.');
  const plan = panelPlanById(pend.planId);
  if (!plan) {
    pendingPanelPay.delete(chatKey);
    return ctx.answerCbQuery('Paket tidak valid.');
  }
  const username = pend.username;
  pendingPanelPay.delete(chatKey);
  try {
    await withPayLock(getChatId(ctx), async () => {
        const dup = await findPendingPayment(getChatId(ctx));
        if (dup) {
          await ctx.reply(`⏳ Selesaikan pembayaran QR sebelumnya dulu (ref: ${dup.reference}) atau batalkan sebelum membuat yang baru.`);
          return;
        }
        const qris = await createQris(plan.price);
        const order = {
          id: randomUUID(),
          kind: 'panel',
          payMethod: 'qris',
          chatId: getChatId(ctx),
          buyerName: ctx.from?.first_name || '',
          panelId: plan.id,
          panelLabel: plan.label,
          panelUsername: username,
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
          `🛡️ Panel ${plan.label}\n━━━━━━━━━━━━━━━━━━\n👤 Username : ${username}\n` +
          `💰 Total bayar : ${formatRupiah(qris.total)} (sudah termasuk fee + kode unik)\n📷 Scan QR pada foto ini.\n\n` +
          `🧾 ID Pembayaran : ${qris.reference}\n` +
          qrisExpiryText(qris) + `\n\n` +
          `💡 Panduan Pembayaran:\n` +
          `1. Scan kode QR di atas\n` +
          `2. Bayar tepat sesuai nominal total\n` +
          `3. Kirim foto bukti transfer ke bot ini\n` +
          `4. Admin akan segera memproses pesananmu\n\n` +
          `📌 Catatan:\n` +
          `• Simpan ID pembayaran untuk referensi\n` +
          `• Pesanan diproses manual oleh admin\n` +
          `• Gunakan tombol di bawah jika ingin membatalkan`;
        await sendQrisPhoto(ctx, qris, order, caption);
        await ctx.answerCbQuery().catch(() => {});
      });
    } catch (error) {
      await ctx.answerCbQuery('Gagal membuat QRIS.').catch(() => {});
      await ctx.reply(`😔 Maaf, terjadi kendala: ${error.message}`);
    }
});

bot.action('ppay:saldo', async (ctx) => {
  const chatKey = String(getChatId(ctx));
  const pend = pendingPanelPay.get(chatKey);
  if (!pend) return ctx.answerCbQuery('Pilihan kedaluwarsa. Ulangi dari menu panel.');
  const plan = panelPlanById(pend.planId);
  if (!plan) {
    pendingPanelPay.delete(chatKey);
    return ctx.answerCbQuery('Paket tidak valid.');
  }
  const username = pend.username;
  pendingPanelPay.delete(chatKey);
  const chatId = getChatId(ctx);
  const buyerName = ctx.from?.first_name || '';
  const result = await withStockLock(async () => {
    const users = await readJson(usersFile);
    const bal = Number(users?.[chatId]?.balance || 0);
    if (bal < plan.price) return { ok: false, bal };
    users[chatId] = { ...(users[chatId] || {}), balance: bal - plan.price, name: buyerName || users[chatId]?.name };
    const orders = await readJson(ordersFile);
    const order = {
      id: randomUUID(),
      kind: 'panel',
      payMethod: 'balance',
      chatId,
      buyerName,
      panelId: plan.id,
      panelLabel: plan.label,
      panelUsername: username,
      reference: null,
      createdAt: Date.now(),
      deliveredAt: Date.now(),
      total: plan.price,
      status: 'paid_panel',
    };
    orders[order.id] = order;
    await writeJson(usersFile, users);
    await writeJson(ordersFile, orders);
    return { ok: true, order, left: bal - plan.price };
  });
  if (!result.ok) {
    await ctx.answerCbQuery('Saldo kurang.').catch(() => {});
    await ctx.reply(
      `💳 Saldo kamu ${formatRupiah(result.bal)}, belum cukup untuk Panel ${plan.label} (${formatRupiah(plan.price)}). Yuk isi saldo dulu.`,
      Markup.inlineKeyboard([[Markup.button.callback('➕ Isi Saldo Sekarang', 'topup')]])
    ).catch(() => {});
    return;
  }
  await afterPanelPaid(result.order);
  await ctx.answerCbQuery('Saldo terpotong. Pesanan diproses admin.').catch(() => {});
});

// User kirim foto bukti TF panel -> teruskan ke admin (dengan konteks order)
bot.on('photo', async (ctx, next) => {
  try {
    const photos = ctx.message?.photo || [];
    if (!photos.length || ctx.chat?.type !== 'private') return next();
    let ctxOrder = null;
    try {
      const orders = await readJson(ordersFile);
      const mine = Object.values(orders)
        .filter((o) => o && o.kind === 'panel' && o.chatId === getChatId(ctx) && (o.status === 'pending' || o.status === 'paid_panel'))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      ctxOrder = mine[0] || null;
    } catch {}
    if (!ctxOrder) return next(); // bukan bukti panel -> lewatkan (contact/testi flow)
    const fileId = photos[photos.length - 1].file_id;
    const from = ctx.from;
    const buyer = `${from?.first_name || 'User'} (@${from?.username || '-'} | ${ctx.chat?.id})`;
    const info = `📦 Panel ${ctxOrder.panelLabel} | 👤 ${ctxOrder.panelUsername} | 💰 ${formatRupiah(ctxOrder.total)} | Ref: ${ctxOrder.reference} | Status: ${ctxOrder.status}`;
    const userCap = (ctx.message?.caption || '').trim();
    if (!config.adminIds.length) {
      await ctx.reply('✅ Bukti diterima. Mohon tunggu balasan admin ya 🙏');
      return;
    }
    for (const id of config.adminIds) {
      try {
        await bot.telegram.sendPhoto(id, fileId, {
          caption: `🧾 Bukti TF panel masuk\n👤 ${buyer}\n${info}\n📝 ${userCap || '-'}\n\nBalas pakai:\n/balas ${ctx.chat?.id} <detail panel>`,
        });
      } catch (e) {
        console.error(`Gagal teruskan bukti panel ke admin ${id}:`, e.message);
      }
    }
    await ctx.reply('✅ Bukti diterima — pembayaran berhasil. Pesananmu sedang diproses, mohon tunggu balasan admin ya 🙏');
  } catch (e) {
    console.error('Gagal proses foto bukti panel:', e.message);
    try { await next(); } catch {}
  }
});

// /balas <id_user> <pesan> — admin balas user
bot.command('balas', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = (ctx.message?.text || '').replace(/^\/balas(@\w+)?/, '').trim().split(/\s+/).filter(Boolean);
  if (args.length < 2) {
    await ctx.reply('Format: /balas <id_user> <pesan>\nContoh: /balas 123456 VPS kamu sudah direset, coba lagi');
    return;
  }
  const target = args[0].replace(/[^0-9]/g, '');
  const msg = (ctx.message.text.split(/\s+/).slice(2).join(' ')).trim();
  if (!target || !msg) { await ctx.reply('ID / pesan tidak valid.'); return; }
  try {
    await bot.telegram.sendMessage(target, `💬 Balasan Admin\n━━━━━━━━━━━━━━━━━━\n\n${msg}`);
    await ctx.reply('✅ Balasan terkirim ke user.');
  } catch (e) {
    await ctx.reply(`😔 Gagal mengirim: ${e.message}`);
    return;
  }
  // Kalau target punya order panel lunas yang belum ditanya testi,
  // tawarkan ke buyer: mau kirim testi ke channel apa enggak.
  try {
    const orders = await readJson(ordersFile);
    const cand = Object.values(orders)
      .filter((o) => o && o.kind === 'panel' && String(o.chatId) === String(target) && o.status === 'paid_panel' && !o.testiAsked)
      .sort((a, b) => (b.deliveredAt || b.createdAt || 0) - (a.deliveredAt || a.createdAt || 0))[0];
    if (cand) {
      cand.testiAsked = true;
      await writeJson(ordersFile, orders);
      await bot.telegram.sendMessage(
        target,
        `⭐ Panel kamu sudah dikirim admin!\nApakah kamu berkenan mengirim testimoni ke kanal kami? 🙏`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Ya, kirim testimoni', `testi:yes:${cand.id}`)],
          [Markup.button.callback('❌ Tidak, terima kasih', `testi:no:${cand.id}`)],
        ])
      ).catch(() => {});
    }
  } catch {}
});

// Buyer jawab tawaran testi panel
bot.action(/^testi:(yes|no):(.+)$/, async (ctx) => {
  const want = ctx.match[1];
  const orderId = ctx.match[2];
  const chatId = getChatId(ctx);
  try {
    const orders = await readJson(ordersFile);
    const order = orders[orderId];
    if (!order || order.chatId !== chatId || order.kind !== 'panel') {
      return ctx.answerCbQuery('Order tidak ditemukan.');
    }
    if (order.testiSent) {
      await ctx.answerCbQuery('Testimoni sudah dikirim.').catch(() => {});
      return;
    }
    if (want === 'no') {
      order.testiSent = 'declined';
      await writeJson(ordersFile, orders);
      await ctx.answerCbQuery('Siap, santai saja!').catch(() => {});
      await ctx.reply('Siap, terima kasih banyak atas orderannya! 🙏').catch(() => {});
      return;
    }
    order.testiSent = true;
    await writeJson(ordersFile, orders);
    await sendTesti('buy', {
      name: order.buyerName || 'Pembeli',
      detail: `Panel ${order.panelLabel || ''} (${order.panelUsername || ''})`.trim(),
      amount: formatRupiah(order.total || 0),
      ref: order.reference || order.id,
    });
    await ctx.answerCbQuery('Testimoni terkirim!').catch(() => {});
    await ctx.reply('✅ Testimoni kamu sudah terkirim ke kanal. Terima kasih banyak! ⭐').catch(() => {});
  } catch {
    await ctx.answerCbQuery('Gagal proses testi.').catch(() => {});
  }
});

// ---- Perintah admin ----
// /admin — panel + daftar semua command admin
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { list } = await getPromoTargets();
  const tg = await getTestiId();
  let blocked = 0;
  try { blocked = normBlocked(await readJson(groupsFile)).length; } catch {}
  await ctx.reply(
    `🛠 Panel Admin — ${config.shopName}\n` +
    `📢 Target promosi: ${list.length} GB${blocked ? ` (${blocked} di-block)` : ''}\n` +
    `⭐ Testimoni: ${tg || '(belum diset di .env)'}\n\n` +
    `📋 Command admin:\n` +
    `/broadcast <teks> — kirim promosi ke semua GB\n` +
    `/bclist — lihat daftar GB + nomor\n` +
    `/bcblock <nomor> — block GB biar gak kena broadcast\n` +
    `/bcunblock <nomor> — buka block\n` +
    `/stok — cek stok\n` +
    `/tambahstok — tambah stok\n` +
    `/tambahsaldo <id> <nominal> — tambah saldo user\n` +
     `/nokosaldo — cek saldo stok nomor\n` +
    `/riwayat [n] — order terakhir\n` +
    `/balas <id> <pesan> — balas pesan user (contact)\n` +
    `/spek — kartu spek VPS\n\n` +
    `Pilih aksi cepat:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📢 Cara Broadcast', 'bc_help'), Markup.button.callback('📋 Daftar GB', 'adm_bclist')],
      [Markup.button.callback('📊 Cek Stok', 'adm_stok'), Markup.button.callback('🧾 Riwayat', 'adm_riwayat')],
      [Markup.button.callback('➕ Cara Tambah Stok', 'adm_addstok'), Markup.button.callback('💰 Cara Tambah Saldo', 'adm_addsaldo')],
      [Markup.button.callback('⛔ Cara Block GB', 'adm_blockhelp'), Markup.button.callback('💬 Cara Balas User', 'adm_balashelp')],
    ])
  );
});

bot.action('bc_help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const { list } = await getPromoTargets();
  await ctx.reply(
    `📢 BROADCAST PROMOSI (khusus admin)\n\n` +
    `Cara 1 — teks langsung:\n/broadcast teks promosi disini...\n\n` +
    `Cara 2 — forward media:\nReply foto/video/dokumen dengan /broadcast, caption ikut terkirim.\n\n` +
    `Target: ${list.length} GB promosi (otomatis semua grup kecuali testimoni).`
  );
});

bot.action('adm_stok', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const remaining = await getStockCount();
  await ctx.reply(`📊 Stok VPS: ${remaining} unit.`);
});

bot.action('adm_addstok', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(`📦 Tambah Stok\nFormat:\n/tambahstok\nip|port|user|pass\nip|port|user|pass\n\nContoh:\n/tambahstok\n1.2.3.4|2222|root|rahasia`);
});

bot.action('adm_addsaldo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(`💰 Tambah Saldo User\nFormat:\n/tambahsaldo <id_telegram> <nominal>\n\nContoh:\n/tambahsaldo 123456 10000`);
});

bot.action('adm_blockhelp', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(`⛔ Block GB\n/bclist — lihat nomor\n/bcblock 2 — block nomor 2 (bisa banyak: /bcblock 1 3)\n/bcunblock 2 — buka block`);
});

bot.action('adm_balashelp', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply(`💬 Balas Pesan User\n━━━━━━━━━━━━━━━━━━\nPesan user masuk ke DM ini lengkap dengan ID.\nBalas dengan:\n/balas <id_user> <pesan>\n\nContoh:\n/balas 123456 VPS kamu sudah direset, silakan coba lagi`);
});

bot.action('adm_riwayat', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const orders = await readJson(ordersFile);
  const list = Object.values(orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
  if (!list.length) { await ctx.reply('Belum ada order.'); return; }
  await ctx.reply(`🧾 5 order terakhir:\n` + list.map((o) => `• ${o.buyerName || o.chatId} — ${o.kind === 'nokos' ? `NOKOS ${o.serviceLabel || ''} ${o.phone || ''}`.trim() : o.kind} — ${o.status} — ${formatRupiah(o.kind === 'topup' ? o.amount : o.total)}`).join('\n'));
});

bot.action('adm_bclist', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendBcList(ctx);
});

async function sendBcList(ctx) {
  let g = {};
  try { g = await readJson(groupsFile); } catch {}
  const all = normGroups(g);
  const blocked = new Set(normBlocked(g));
  const testi = String(config.testiGroupId || '');
  if (!all.length) {
    await ctx.reply('📋 Belum ada GB. Add bot ke grup, otomatis masuk daftar.');
    return;
  }
  for (const e of all) {
    if (!e.title) {
      try {
        const c = await bot.telegram.getChat(e.id);
        e.title = c?.title || e.id;
      } catch { e.title = e.id; }
    }
  }
  try {
    g.promoGroups = all;
    await writeJson(groupsFile, g);
  } catch {}
  const lines = all.map((e, i) => {
    const tags = [];
    if (e.id === testi) tags.push('⭐testi-skip');
    if (blocked.has(e.id)) tags.push('⛔blocked');
    return `${i + 1}. ${e.title || e.id}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
  });
  await ctx.reply(
    `📋 Daftar Grup Broadcast (${all.length})\n━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n')}\n\n` +
    `Blokir: /bcblock <nomor> (cth: /bcblock 2)\nBuka: /bcunblock <nomor>\nGrup testimoni otomatis dilewati.`
  );
}

// /bclist — lihat semua GB + nomor
bot.command('bclist', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await sendBcList(ctx);
});

// /bcblock <nomor> — block GB biar gak kena broadcast. Bisa banyak: /bcblock 1 3
bot.command('bcblock', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = (ctx.message?.text || '').replace(/^\/bcblock(@\w+)?/, '').trim().split(/\s+/).filter(Boolean);
  if (!args.length) {
    await ctx.reply('Format: /bcblock <nomor>\nContoh: /bcblock 2\nLihat nomor di /bclist.');
    return;
  }
  let g = {};
  try { g = await readJson(groupsFile); } catch {}
  const all = normGroups(g);
  const blocked = new Set(normBlocked(g));
  const added = [];
  for (const a of args) {
    const n = Number(a);
    if (!Number.isFinite(n) || n < 1 || n > all.length) continue;
    blocked.add(all[n - 1].id);
    added.push(`${n}. ${all[n - 1].title || all[n - 1].id}`);
  }
  g.blockedGroups = [...blocked];
  await writeJson(groupsFile, g);
  if (!added.length) { await ctx.reply('Nomor tidak valid. Cek /bclist.'); return; }
  await ctx.reply(`⛔ Diblokir (${added.length}):\n${added.join('\n')}\n\nGrup ini tidak akan menerima /broadcast lagi.`);
});

// /bcunblock <nomor> — buka block
bot.command('bcunblock', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = (ctx.message?.text || '').replace(/^\/bcunblock(@\w+)?/, '').trim().split(/\s+/).filter(Boolean);
  if (!args.length) {
    await ctx.reply('Format: /bcunblock <nomor>\nContoh: /bcunblock 2');
    return;
  }
  let g = {};
  try { g = await readJson(groupsFile); } catch {}
  const all = normGroups(g);
  const blocked = new Set(normBlocked(g));
  const opened = [];
  for (const a of args) {
    const n = Number(a);
    if (!Number.isFinite(n) || n < 1 || n > all.length) continue;
    blocked.delete(all[n - 1].id);
    opened.push(`${n}. ${all[n - 1].title || all[n - 1].id}`);
  }
  g.blockedGroups = [...blocked];
  await writeJson(groupsFile, g);
  if (!opened.length) { await ctx.reply('Nomor tidak valid. Cek /bclist.'); return; }
  await ctx.reply(`✅ Dibuka (${opened.length}):\n${opened.join('\n')}\n\nGrup ini akan menerima /broadcast kembali.`);
});

// /broadcast <teks> — khusus admin, kirim ke SEMUA GB promosi (otomatis).
// Kalau dipakai sambil reply foto/video/dokumen, media ikut diteruskan + caption.
bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { list } = await getPromoTargets();
  if (!list.length) {
    await ctx.reply('❌ Bot belum masuk grup promosi manapun.\nAdd bot ke GB, lalu ulangi /broadcast.');
    return;
  }
  const msg = ctx.message || {};
  const reply = msg.reply_to_message;
  const text = (msg.text || '').replace(/^\/broadcast(@\w+)?/, '').trim();

  try {
    // Mode reply media -> copy ke semua grup promosi
    if (reply && (reply.photo || reply.video || reply.document || reply.animation)) {
      const cap = text || reply.caption || '';
      let ok = 0;
      for (const t of list) {
        try {
          if (reply.photo) {
            const fid = reply.photo[reply.photo.length - 1].file_id;
            await bot.telegram.sendPhoto(t.id, fid, { caption: cap.slice(0, 1000) });
          } else if (reply.video) {
            await bot.telegram.sendVideo(t.id, reply.video.file_id, { caption: cap.slice(0, 1000) });
          } else if (reply.animation) {
            await bot.telegram.sendAnimation(t.id, reply.animation.file_id, { caption: cap.slice(0, 1000) });
          } else if (reply.document) {
            await bot.telegram.sendDocument(t.id, reply.document.file_id, { caption: cap.slice(0, 1000) });
          }
          ok++;
        } catch (e) { console.error(`Gagal broadcast media ke ${t.id}:`, e.message); }
      }
      await ctx.reply(ok ? `✅ Broadcast media terkirim ke ${ok} GB.` : '❌ Gagal kirim ke semua GB.');
      return;
    }
    if (!text) {
      await ctx.reply('Format:\n/broadcast <teks promosi>\natau balas foto/video dengan /broadcast <caption>');
      return;
    }
    const ok = await sendToPromo(ctx, `📢 PROMO ${config.shopName}\n━━━━━━━━━━━━\n\n${text}\n\n━━━━━━━━━━━━\n🤖 Order: @${ctx.botInfo?.username || 'bot ini'} | ⭐ Testi: ${config.testiLink}`);
    if (ok) await ctx.reply(`✅ Broadcast terkirim ke ${list.length} GB.`);
  } catch (e) {
    await ctx.reply(`❌ Gagal broadcast: ${e.message}`);
  }
});
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
    await ctx.reply('Format:\n/tambahstok\nip|port|user|pass\nip|port|user|pass\nContoh: 1.2.3.4|2222|root|rahasia');
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
  await ctx.reply(`✅ Stok bertambah +${added}. Sisa sekarang: ${stock.length} unit.`);
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
    const kind = (o.kind || 'buy') === 'topup' ? 'DEPOSIT'
      : (o.kind === 'nokos' || o.kind === 'nokos_pending') ? `NOKOS ${o.serviceLabel || ''} ${o.phone || ''}`.trim()
      : o.kind === 'panel' ? `PANEL ${o.panelLabel || ''} (${o.panelUsername || ''})`.trim()
      : `BELI (${o.payMethod || 'qris'})`;
    const amt = formatRupiah(o.kind === 'topup' ? o.amount : o.total);
    return `• ${date}\n  ${kind} ${amt} — ${o.status} — ${(o.buyerName || o.chatId)} — ${(o.reference || o.id || '').toString().slice(0, 18)}`;
  });
  await ctx.reply(`🧾 ${list.length} order terakhir:\n\n${lines.join('\n\n').slice(0, 3500)}`);
});

// Bot baru masuk grup (di-add / di-approve) -> diam-diam jadi TARGET PROMOSI.
// Tanpa sapaan di grup. Notif cuma ke admin via DM bot.
// Testimoni murni dari TESTI_GROUP_ID di .env.
bot.on('my_chat_member', async (ctx) => {
  try {
    const upd = ctx.myChatMember;
    const st = upd?.new_chat_member?.status;
    const chat = upd?.chat;
    if (!chat || chat.type === 'private') return;
    const id = String(chat.id);
    const title = String(chat.title || 'Grup');
    let g = {};
    try { g = await readJson(groupsFile); } catch {}
    let list = normGroups(g);
    if (['left', 'kicked', 'banned'].includes(st)) {
      list = list.filter((x) => x.id !== id);
      g.promoGroups = list;
      await writeJson(groupsFile, g).catch(() => {});
      await notifyAdmins(`➖ Bot keluar/dikeluarkan dari "${title}" (${id}).\n📢 Sisa target: ${list.length} GB.`);
      return;
    }
    if (!['member', 'administrator'].includes(st)) return;
    const testi = String(config.testiGroupId || '');
    if (id === testi) {
      await notifyAdmins(`⭐ Bot ada di GB TESTIMONI "${title}" (${id}).\nDikecualikan dari broadcast, dipakai testimoni + gate join.`);
      return;
    }
    if (!list.some((x) => x.id === id)) {
      list.push({ id, title });
      g.promoGroups = list;
      await writeJson(groupsFile, g).catch(() => {});
      await notifyAdmins(`➕ Bot masuk GB baru: "${title}" (${id}).\n📢 Otomatis jadi target broadcast. Total: ${list.length} GB.\nKetik /bclist buat lihat daftar.`);
    }
  } catch {}
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

// ---- Auto-backup per jam ke DM admin (fitur, tanpa cron/PC) ----
// Kirim 9 file satuan tiap BACKUP_HOURS jam. Hidup selama bot jalan.
const BACKUP_FILES = [
  'index.js',
  'lib/rumahotp.js',
  'package.json',
  '.env.example',
  'data/users.json',
  'data/orders.json',
  'data/vps_stock.json',
  'data/group_config.json',
  '.env',
];
const backupHours = Number(process.env.BACKUP_HOURS || 1);
// Grup backup (ID GC, bot harus jadi member). Kosong = DM admin pertama.
const backupTarget = process.env.BACKUP_GROUP_ID || process.env.BACKUP_ADMIN_ID || config.adminIds[0] || '';

async function sendBackup(manual = false) {
  if (!backupTarget) {
    if (manual) console.error('Backup: BACKUP_GROUP_ID / ADMIN_IDS kosong.');
    return false;
  }
  let ok = 0;
  for (const f of BACKUP_FILES) {
    try {
      const buf = await readFile(path.join(__dirname, f));
      await bot.telegram.sendDocument(backupTarget, { source: buf, filename: f.replaceAll('/', '_') }, { caption: `💾 ${f}` });
      ok++;
      await new Promise((s) => setTimeout(s, 2000));
    } catch (e) {
      console.error(`Backup gagal ${f}:`, e.message);
    }
  }
  console.log(`Backup ${manual ? 'manual' : 'otomatis'}: ${ok}/${BACKUP_FILES.length} file ke ${backupTarget}`);
  return ok > 0;
}

bot.command('backup', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply('💾 Backup manual jalan, tunggu file masuk DM...');
  await sendBackup(true);
});

if (backupHours > 0 && backupTarget) {
  const ms = backupHours * 3600_000;
  const t = setInterval(() => { sendBackup(false).catch(() => {}); }, ms);
  if (typeof t.unref === 'function') t.unref();
  console.log(`Auto-backup tiap ${backupHours} jam ke ${backupTarget}`);
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
