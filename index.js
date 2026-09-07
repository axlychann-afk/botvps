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
  topupUrl: process.env.QRIS_TOPUP_URL || 'https://qris.zakki.store/topup',
  // Default ke endpoint resmi zakki.store (GET ?idtopup=...).
  // Bisa dioverride pakai endpoint custom POST { token, reference }.
  statusUrl: process.env.QRIS_STATUS_URL || 'https://qris.zakki.store/cektopup',
  cancelUrl: process.env.QRIS_CANCEL_URL || 'https://qris.zakki.store/cancel',
  pollSeconds: Number(process.env.PAYMENT_POLL_SECONDS || 15),
  timeoutMinutes: Number(process.env.PAYMENT_TIMEOUT_MINUTES || 10),
  // Total kapasitas stok untuk bar persen. Isi mis. 102. Kalau 0/kosong, total = sisa saat ini.
  stockTotal: Number(process.env.STOCK_TOTAL || 0),
  productSpec: process.env.PRODUCT_SPEC || 'NAT | Unlimited',
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

// ---- Helpers QRIS (sesuai docs https://qris.zakki.store) ----
// Topup sukses:
// { code:201, data:{ id_transaksi, rincian:{total_bayar}, expired_at, qris_image, qris_content, cancel_url, cektopup_url } }
// Cek sukses-pending:
// { kategori_status:"PENDING"|"SUCCESS", data:{ status:"PENDING"|"SUCCESS", id_transaksi } }

function paymentImage(response) {
  return (
    response.qr_url ||
    response.qris_url ||
    response.payment_url ||
    response.url ||
    response.image ||
    response.qris_image ||
    response.data?.qr_url ||
    response.data?.qris_url ||
    response.data?.payment_url ||
    response.data?.url ||
    response.data?.qris_image ||
    response.data?.image_url ||
    response.data?.qris_data?.image_url ||
    null
  );
}

function paymentContent(response) {
  return (
    response.qris_content ||
    response.data?.qris_content ||
    response.data?.qris_data?.raw_string ||
    null
  );
}

function paymentReference(response) {
  return (
    response.reference ||
    response.transaction_id ||
    response.id_transaksi ||
    response.id ||
    response.file_id ||
    response.data?.reference ||
    response.data?.transaction_id ||
    response.data?.id_transaksi ||
    response.data?.id ||
    response.file_id ||
    null
  );
}

function paymentTotal(response, fallback = PRICE) {
  return (
    response.total_bayar ||
    response.data?.rincian?.total_bayar ||
    response.data?.nominal_total ||
    response.data?.rincian?.nominal_request ||
    fallback
  );
}

function paymentExpiredAt(response) {
  return response.expired_at || response.data?.expired_at || null;
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

async function createQris() {
  const response = await fetch(config.topupUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.qrisToken, nominal: PRICE }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `QRIS HTTP ${response.status}`);
  const image = paymentImage(body);
  const reference = paymentReference(body);
  if (!image || !reference) {
    throw new Error(
      `Respons topup tidak dikenali (butuh qris_image + id_transaksi). Dapat: ${JSON.stringify(body).slice(0, 300)}`
    );
  }
  return {
    image,
    content: paymentContent(body),
    reference,
    total: paymentTotal(body),
    expiredAt: paymentExpiredAt(body),
    cancelUrl: body.cancel_url || body.data?.cancel_url || null,
    checkUrl: body.cektopup_url || body.data?.cektopup_url || null,
    raw: body,
  };
}

async function checkPayment(order) {
  const reference = order.reference;
  if (!reference) return false;

  // Jalur resmi zakki.store: GET /cektopup?idtopup=xxx
  if (config.statusUrl.includes('cektopup')) {
    const url = `${config.statusUrl}${config.statusUrl.includes('?') ? '&' : '?'}idtopup=${encodeURIComponent(reference)}`;
    const response = await fetch(url, { method: 'GET' });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404) return false; // belum ada / tidak ditemukan = belum bayar
    if (!response.ok) throw new Error(body.message || `Status QRIS HTTP ${response.status}`);
    return paid(body);
  }

  // Fallback endpoint custom: POST { token, reference }
  const response = await fetch(config.statusUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: config.qrisToken, reference }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Status QRIS HTTP ${response.status}`);
  return paid(body);
}

// Batalkan tiket QRIS pending di zakki.store: GET /cancel?token=...&id_transaksi=...
async function cancelPayment(order) {
  const reference = order.reference;
  if (!reference) return true;
  const url = `${config.cancelUrl}${config.cancelUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(config.qrisToken)}&id_transaksi=${encodeURIComponent(reference)}`;
  const response = await fetch(url, { method: 'GET' });
  const body = await response.json().catch(() => ({}));
  // 404 = sudah tidak ada / kadaluarsa -> anggap sudah batal
  if (response.status === 404) return true;
  if (!response.ok) throw new Error(body.message || `Cancel QRIS HTTP ${response.status}`);
  return true;
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

function startPolling(orderId) {
  if (pollTimers.has(orderId)) return;
  if (!config.pollSeconds || config.pollSeconds <= 0) return;
  const timer = setInterval(async () => {
    try {
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
      if (await checkPayment(order)) {
        await withStockLock(() => deliver(order.id));
        stopPolling(orderId);
      }
    } catch {
      // biarkan polling berikutnya mencoba lagi
    }
  }, config.pollSeconds * 1000);
  // Jangan menahan proses Node tetap hidup hanya karena polling
  if (typeof timer.unref === 'function') timer.unref();
  pollTimers.set(orderId, timer);
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

// Tampilan /start gaya auto-order dengan stok live.
// Kalau stok < 2, tombol beli diganti tombol refresh (order diblokir di action 'buy' juga).
async function buildStart(name) {
  const remaining = await getStockCount();
  const total = config.stockTotal > 0 ? config.stockTotal : Math.max(remaining, 1);
  const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;
  const empty = remaining < 2;
  const text =
    `ᴀᴜᴛᴏ ᴏʀᴅᴇʀ VPS NAT • ᴄᴇᴘᴀᴛ & ᴛᴇʀᴘᴇʀᴄᴀʏᴀ\n` +
    `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n\n` +
    `👋 ʜᴀʟᴏ, ${name}!\n` +
    `sᴇʟᴀᴍᴀᴛ ᴅᴀᴛᴀɴɢ ᴅɪ ʙᴏᴛ ᴀᴜᴛᴏ ᴏʀᴅᴇʀ ᴋᴀᴍɪ 🚀\n\n` +
    `💰 sᴀʟᴅᴏ ᴀɴᴅᴀ: ʀᴘ0\n\n` +
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
    : Markup.inlineKeyboard([[Markup.button.callback(`🛒 Beli 2 VPS — ${formatRupiah(PRICE)}`, 'buy')]]);
  return { text, buttons };
}

bot.start(async (ctx) => {
  const name = ctx.from?.first_name || 'kak';
  const { text, buttons } = await buildStart(name);
  await ctx.reply(text, buttons);
});

bot.action('cek_stok', async (ctx) => {
  try {
    const name = ctx.from?.first_name || 'kak';
    const { text, buttons } = await buildStart(name);
    await ctx.answerCbQuery();
    await ctx.reply(text, buttons);
  } catch {
    await ctx.answerCbQuery('Gagal cek stok.');
  }
});

bot.action('buy', async (ctx) => {
  try {
    const stock = await readJson(stockFile);
    if (!Array.isArray(stock) || stock.length < 2) return ctx.answerCbQuery('Stok habis.');
  } catch (e) {
    return ctx.answerCbQuery('Stok belum siap.');
  }
  try {
    const qris = await createQris();
    const chatId = getChatId(ctx);
    const order = {
      id: randomUUID(),
      chatId,
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

    const expiredInfo = qris.expiredAt
      ? `⏰ Bayar sebelum: ${new Date(qris.expiredAt).toLocaleString('id-ID')}`
      : `⏰ Batas: ${config.timeoutMinutes} menit`;
    // Foto aja: caption singkat tanpa string QRIS panjang
    const caption =
      `Bayar ${formatRupiah(qris.total)} (total sudah termasuk kode unik) lewat QR di foto ini.\n\n` +
      `Reference: ${qris.reference}\n` +
      expiredInfo;
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Cek pembayaran', `check:${order.id}`)],
      [Markup.button.callback('❌ Batalkan pembayaran', `cancel:${order.id}`)],
    ]);

    // Foto aja, tanpa link: gambar di-download server lalu di-upload sebagai file,
    // jadi Telegram tidak perlu fetch URL host gambar (sering gagal).
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
        `${caption}\n\n⚠️ Foto QR gagal dimuat. Batalkan pesanan ini lalu tekan Beli lagi untuk QR baru.`,
        buttons
      );
    }
    await ctx.answerCbQuery();
  } catch (error) {
    await ctx.answerCbQuery('Gagal membuat QRIS.');
    await ctx.reply(`Gagal: ${error.message}`);
  }
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
    if (order.status === 'delivered') return ctx.answerCbQuery('Data sudah dikirim, tidak bisa dibatalkan.');
    if (order.status === 'cancelled') return ctx.answerCbQuery('Pesanan sudah dibatalkan.');
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

// ---- Start ----
try {
  await ensureData();
} catch (e) {
  console.error(`Gagal start: ${e.message}`);
  process.exit(1);
}

console.log('Menghubungkan ke Telegram...');
console.log(`Topup: ${config.topupUrl}`);
console.log(`Status: ${config.statusUrl}`);

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
