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
  // Spek host (dari neofetch VPS 2026-09-08). Catatan: NAT container lihat spek host;
  // alokasi riil per unit ikut PRODUCT_SPEC. Update VPS_SPECS bila host ganti.
  vpsSpecs: String(process.env.VPS_SPECS || 'Xeon Platinum 8581C (32 Core),RAM 258GB DDR5,NVMe SSD,Google Cloud Network').split(',').map((s) => s.trim()).filter(Boolean),
  adminIds: String(process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  testiGroupId: process.env.TESTI_GROUP_ID || '',
  promoGroupId: process.env.PROMO_GROUP_ID || '',
  testiLink: process.env.TESTI_LINK || 'https://t.me/testimonialnat',
  promoLink: process.env.PROMO_LINK || '',
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

async function sendToPromo(ctx, text, extra = {}) {
  const { list } = await getPromoTargets();
  if (!list.length) {
    await ctx.reply('❌ Bot belum masuk grup promosi manapun.\nAdd bot ke GB promosi (nama bebas, acak juga oke), lalu /broadcast lagi.\nYang perlu /settesti cuma GB TESTIMONI.');
    return false;
  }
  let ok = 0;
  for (const target of list) {
    try {
      await bot.telegram.sendMessage(target, text, extra);
      ok++;
    } catch (e) {
      console.error(`Gagal kirim promosi ke ${target}:`, e.message);
    }
  }
  if (!ok) {
    await ctx.reply('❌ Gagal kirim ke semua GB. Pastikan bot masih ada di grup & jadi admin/member.');
    return false;
  }
  return true;
}

// ID grup auto-daftar (tanpa copy manual): .env dulu, kalau kosong pakai data/group_config.json
async function getPromoId() {
  if (config.promoGroupId) return config.promoGroupId;
  try {
    const g = await readJson(groupsFile);
    if (Array.isArray(g?.promoGroups) && g.promoGroups.length) return g.promoGroups[0];
    return g?.promoGroupId || '';
  } catch { return ''; }
}
// Semua target broadcast: semua grup yang dikenal KECUALI grup testimoni.
// Jadi GB apapun yang bot dimasukin otomatis jadi target promosi.
async function getPromoTargets() {
  try {
    const g = await readJson(groupsFile);
    const testi = config.testiGroupId || g?.testiGroupId || '';
    let list = [];
    if (Array.isArray(g?.promoGroups)) list = [...g.promoGroups];
    if (g?.promoGroupId) list.push(String(g.promoGroupId));
    if (config.promoGroupId) list.push(String(config.promoGroupId));
    list = [...new Set(list.map(String))].filter((id) => id && id !== String(testi));
    return { list, testi: String(testi) };
  } catch { return { list: config.promoGroupId ? [String(config.promoGroupId)] : [], testi: '' }; }
}
async function getTestiId() {
  if (config.testiGroupId) return config.testiGroupId;
  try {
    const g = await readJson(groupsFile);
    return g?.testiGroupId || '';
  } catch { return ''; }
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
<text x="400" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="38" font-weight="bold" fill="#ffffff" letter-spacing="2">💻 SPESIFIKASI VPS</text>
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
    : `💻 Spesifikasi VPS ${config.shopName}\n💰 ${formatRupiah(UNIT_PRICE)}/unit — pencet /start buat order.`;
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
  await ctx.reply(caption + `\nOS: Ubuntu 22.04.5 LTS\nCPU: Xeon Platinum 8581C (32)\nRAM: 258GB\nStok: ${stock} unit`);
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
  if (stock.length < 1) throw new Error('Stok VPS habis.');
  const vps = stock.splice(0, 1);
  await writeJson(stockFile, stock);
  order.status = 'delivered';
  order.deliveredAt = Date.now();
  order.vps = vps;
  await writeJson(ordersFile, orders);
  await bot.telegram.sendMessage(
    order.chatId,
    `VPS Berhasil Dibuat\n───────────◆───────────\n\n${vpsMessage(vps[0], 1)}\n\nSimpan baik-baik. Jangan share ke orang lain.`
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
  const t0 = Date.now();
  const remaining = await getStockCount();
  const balance = chatId ? await getBalance(chatId) : 0;
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
    `VPS NAT Premium — Cepat, Stabil, Terpercaya\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Halo, ${name}! 👋\n` +
    `Selamat datang di layanan auto-order kami.\n\n` +
    `💰 Saldo Anda : ${formatRupiah(balance)}\n\n` +
    `📦 Produk : VPS NAT\n` +
    `│  • Harga : ${formatRupiah(UNIT_PRICE)} / unit\n` +
    `${specLines ? specLines + '\n' : ''}` +
    `${liveLines ? liveLines + '\n' : ''}` +
    `└ Spesifikasi : ${config.productSpec}\n\n` +
    `📊 Stok : ${dot} ${remaining}/${total} unit (${percent}%)\n` +
    `${stockBar(percent)}\n` +
    (empty ? `\n❌ Stok sedang habis — coba lagi nanti.\n` : ``) +
    `\n━━━━━━━━━━━━━━━━━━\n` +
    `⚡ Proses otomatis setelah pembayaran\n` +
    `🔒 Aman & terpercaya — bukti order di channel testimoni`;
  const rows = empty
    ? [[Markup.button.callback('🔄 Cek Stok', 'cek_stok')]]
    : [
        [Markup.button.callback(`🛒 Beli 1 VPS • ${formatRupiah(PRICE)} (QRIS)`, 'buy')],
        [Markup.button.callback('💰 Beli pakai Saldo', 'buy_balance'), Markup.button.callback('➕ Top Up', 'topup')],
      ];
  rows.push([Markup.button.callback('🖥 Lihat Spek (Gambar)', 'lihat_spek')]);
  rows.push([Markup.button.url('⭐ Testimoni', config.testiLink)]);
  return { text, buttons: Markup.inlineKeyboard(rows) };
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

// Teks menu versi caption foto (1024 char max) — spek detail ada di gambar, di sini ringkas.
function menuCaption(name, balance, remaining, total, percent, dot, empty) {
  return (
    `✦ ${config.shopName} ✦ — Halo, ${name}! 👋\n` +
    `💰 Saldo : ${formatRupiah(balance)} | 📦 1 VPS = ${formatRupiah(UNIT_PRICE)}\n` +
    `📊 Stok : ${dot} ${remaining}/${total} (${percent}%) ${stockBar(percent)}\n` +
    (empty ? `❌ Stok habis — coba lagi nanti.\n` : ``) +
    `⚡ Auto-order setelah bayar 🔒 Testimoni di channel`
  ).slice(0, 1000);
}

bot.start(async (ctx) => {
  const name = ctx.from?.first_name || 'kak';
  const chatId = getChatId(ctx);
  // GATE: wajib gabung GB Testimoni dulu sebelum menu utama muncul
  const joined = await isJoinedTesti(ctx.from.id);
  if (!joined) {
    await ctx.reply(
      `Halo, ${name}! 👋\n\n` +
      `Sebelum bisa order, kamu WAJIB gabung dulu ke GB Testimoni kami:\n` +
      `👉 ${config.testiLink}\n\n` +
      `Klik tombol di bawah untuk gabung, lalu pencet "✅ Saya Sudah Gabung".`,
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
    const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
    const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
    const dot = remaining < 1 ? '🔴' : percent < 30 ? '🟡' : '🟢';
    await ctx.replyWithPhoto({ source: photo }, {
      caption: menuCaption(name, balance, remaining, total, percent, dot, remaining < 1),
      ...buttons,
    }).catch(async () => { await ctx.reply(text, buttons); });
    return;
  }
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
    `💰 Saldo kamu: ${formatRupiah(balance)}\n\nTop up dulu sebelum beli pakai saldo. 1 VPS = ${formatRupiah(PRICE)}.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Top Up Saldo', 'topup')],
      [Markup.button.callback(`💰 Beli 1 VPS — ${formatRupiah(PRICE)}`, 'buy_balance')],
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
    if (!(await isJoinedTesti(ctx.from.id))) {
      await ctx.answerCbQuery('Gabung GB Testimoni dulu!');
      await ctx.reply(`⚠️ Wajib gabung GB Testimoni dulu sebelum order:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {});
      return;
    }
    const stock = await readJson(stockFile);
    if (!Array.isArray(stock) || stock.length < 1) return ctx.answerCbQuery('Stok habis.');
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
  if (!(await isJoinedTesti(ctx.from.id))) {
    await ctx.reply(`⚠️ Wajib gabung GB Testimoni dulu sebelum top up:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {});
    return;
  }
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
  if (!(await isJoinedTesti(ctx.from.id))) {
    await ctx.answerCbQuery('Gabung GB Testimoni dulu!');
    await ctx.reply(`⚠️ Wajib gabung GB Testimoni dulu sebelum order:\n👉 ${config.testiLink}`, joinGateButtons()).catch(() => {});
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
      `VPS Berhasil Dibuat (Saldo)\n───────────◆───────────\n\n${vpsMessage(result.vps[0], 1)}\n\nSimpan baik-baik. Jangan share ke orang lain.`
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

bot.action('cek_join', async (ctx) => {
  const joined = await isJoinedTesti(ctx.from.id);
  if (!joined) {
    await ctx.answerCbQuery('Kamu belum gabung. Join dulu ya!');
    await ctx.reply(
      `❌ Belum terdeteksi join.\nGabung dulu: 👉 ${config.testiLink}\nLalu pencet tombol di bawah lagi.`,
      joinGateButtons()
    ).catch(() => {});
    return;
  }
  await ctx.answerCbQuery('✅ Terima kasih sudah gabung!');
  const name = ctx.from?.first_name || 'kak';
  const { text, buttons } = await buildStart(name, getChatId(ctx));
  const photo = await specPhoto();
  if (photo) {
    const remaining = await getStockCount();
    const balance = await getBalance(getChatId(ctx));
    const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
    const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
    const dot = remaining < 1 ? '🔴' : percent < 30 ? '🟡' : '🟢';
    await ctx.replyWithPhoto({ source: photo }, {
      caption: menuCaption(name, balance, remaining, total, percent, dot, remaining < 1),
      ...buttons,
    }).catch(async () => { await ctx.reply(text, buttons); });
    return;
  }
  await ctx.reply(text, buttons);
});

// ---- Perintah admin ----
// /settesti — SATU-SATUNYA command wajib, ketik DI DALAM GB Testimoni.
// /setpromo — opsional, buat daftarin grup manual kalau event auto ke-skip.
bot.command('setpromo', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat?.type === 'private') {
    const { list } = await getPromoTargets();
    await ctx.reply(`📢 Target promosi saat ini (${list.length}):\n${list.join('\n') || '(kosong — add bot ke grup, otomatis masuk)'}\n\nKalau ada grup ke-skip, masuk ke grup itu lalu ketik /setpromo di sana.`);
    return;
  }
  let g = {};
  try { g = await readJson(groupsFile); } catch {}
  if (!Array.isArray(g.promoGroups)) g.promoGroups = [];
  const id = String(ctx.chat.id);
  if (!g.promoGroups.map(String).includes(id)) g.promoGroups.push(id);
  // kalau grup ini sempat ketandai testimoni, cabut
  if (String(g.testiGroupId) === id) delete g.testiGroupId;
  await saveGroupId('promoGroups', g.promoGroups);
  await writeJson(groupsFile, g);
  await ctx.reply(`✅ GB ini terdaftar sebagai TARGET PROMOSI.\nID: ${ctx.chat.id}`);
});
bot.command('settesti', async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat?.type === 'private') {
    await ctx.reply('Ketik /settesti DI DALAM GB Testimoni (bukan di sini). Cuma grup ini yang perlu ditandai — sisanya otomatis promosi.');
    return;
  }
  const id = String(ctx.chat.id);
  await saveGroupId('testiGroupId', id);
  // cabut dari daftar promosi biar broadcast gak nyasar ke sini
  try {
    let g = await readJson(groupsFile);
    if (Array.isArray(g.promoGroups)) {
      g.promoGroups = g.promoGroups.filter((x) => String(x) !== id);
      if (g.promoGroupId && String(g.promoGroupId) === id) delete g.promoGroupId;
      await writeJson(groupsFile, g);
    }
  } catch {}
  await ctx.reply(`✅ GB ini terdaftar sebagai GB TESTIMONI.\nID: ${ctx.chat.id}\nTestimoni otomatis + gate join pakai grup ini. Grup lain (nama bebas/acak) otomatis jadi target broadcast.`);
});
// /admin — panel khusus admin
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { list } = await getPromoTargets();
  const tg = await getTestiId();
  await ctx.reply(
    `🛠 Panel Admin — ${config.shopName}\n` +
    `GB Promosi: ${list.length} grup (otomatis, nama bebas)\n` +
    `GB Testimoni: ${tg || '(belum diset — ketik /settesti di grup testimoni)'}\n\n` +
    `Pilih aksi:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('📢 Broadcast Teks ke GB Promosi', 'bc_help')],
      [Markup.button.callback('📊 Cek Stok', 'adm_stok'), Markup.button.callback('🧾 Riwayat', 'adm_riwayat')],
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
    `Target: ${list.length} GB promosi (otomatis semua grup kecuali testimoni).\n` +
    `Cuma GB Testimoni yang perlu /settesti 1x.`
  );
});

bot.action('adm_stok', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const remaining = await getStockCount();
  await ctx.reply(`📊 Stok VPS: ${remaining} unit.`);
});

bot.action('adm_riwayat', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const orders = await readJson(ordersFile);
  const list = Object.values(orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
  if (!list.length) { await ctx.reply('Belum ada order.'); return; }
  await ctx.reply(`🧾 5 order terakhir:\n` + list.map((o) => `• ${o.buyerName || o.chatId} — ${o.status} — ${formatRupiah(o.kind === 'topup' ? o.amount : o.total)}`).join('\n'));
});

// /broadcast <teks> — khusus admin, kirim ke SEMUA GB promosi (otomatis).
// Kalau dipakai sambil reply foto/video/dokumen, media ikut diteruskan + caption.
bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { list } = await getPromoTargets();
  if (!list.length) {
    await ctx.reply('❌ Bot belum masuk grup promosi manapun.\nAdd bot ke GB (nama bebas/acak), otomatis jadi target.\nCuma GB Testimoni yang perlu /settesti 1x.');
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
      for (const target of list) {
        try {
          if (reply.photo) {
            const fid = reply.photo[reply.photo.length - 1].file_id;
            await bot.telegram.sendPhoto(target, fid, { caption: cap.slice(0, 1000) });
          } else if (reply.video) {
            await bot.telegram.sendVideo(target, reply.video.file_id, { caption: cap.slice(0, 1000) });
          } else if (reply.animation) {
            await bot.telegram.sendAnimation(target, reply.animation.file_id, { caption: cap.slice(0, 1000) });
          } else if (reply.document) {
            await bot.telegram.sendDocument(target, reply.document.file_id, { caption: cap.slice(0, 1000) });
          }
          ok++;
        } catch (e) { console.error(`Gagal broadcast media ke ${target}:`, e.message); }
      }
      await ctx.reply(ok ? `✅ Broadcast media terkirim ke ${ok} GB.` : '❌ Gagal kirim ke semua GB.');
      return;
    }
    if (!text) {
      await ctx.reply('Format:\n/broadcast teks promosi disini...\natau reply foto/video dengan /broadcast caption');
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

// Bot baru masuk grup (di-add / di-approve) -> otomatis jadi TARGET PROMOSI.
// Nama grup BEBAS / acak, gak perlu kata kunci. Satu-satunya yang perlu
// ditandai manual: GB TESTIMONI via /settesti di grup itu.
bot.on('my_chat_member', async (ctx) => {
  try {
    const upd = ctx.myChatMember;
    const st = upd?.new_chat_member?.status;
    const chat = upd?.chat;
    if (!chat || chat.type === 'private') return;
    const id = String(chat.id);
    let g = {};
    try { g = await readJson(groupsFile); } catch {}
    if (!Array.isArray(g.promoGroups)) g.promoGroups = [];
    // Bot dikick / dibanned -> cabut dari daftar
    if (['left', 'kicked', 'banned'].includes(st)) {
      g.promoGroups = g.promoGroups.filter((x) => String(x) !== id);
      await writeJson(groupsFile, g).catch(() => {});
      return;
    }
    if (!['member', 'administrator'].includes(st)) return;
    const testi = String(config.testiGroupId || g.testiGroupId || '');
    if (id === testi) return; // grup testimoni bukan target promosi
    if (!g.promoGroups.map(String).includes(id)) {
      g.promoGroups.push(id);
      await writeJson(groupsFile, g);
      await ctx.reply(`✅ Halo! Grup ini otomatis jadi TARGET PROMOSI.\n/broadcast dari chat admin bakal terkirim ke sini.\n⚠️ Jangan jadikan grup testimoni — kalau ini grup testimoni, admin ketik /settesti.`).catch(() => {});
      await notifyAdmins(`✅ Auto-promosi: "${chat.title}" (${id}) ditambah. Total target: ${g.promoGroups.length}.`);
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

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
