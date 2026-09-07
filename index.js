import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';

const required = ['BOT_TOKEN', 'QRIS_TOKEN'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} belum diisi di .env`);

const config = {
  qrisToken: process.env.QRIS_TOKEN,
  topupUrl: process.env.QRIS_TOPUP_URL || 'https://qris.zakki.store/topup',
  statusUrl: process.env.QRIS_STATUS_URL,
  pollSeconds: Number(process.env.PAYMENT_POLL_SECONDS || 15),
  timeoutMinutes: Number(process.env.PAYMENT_TIMEOUT_MINUTES || 15),
};
const dataDir = new URL('./data/', import.meta.url);
const stockFile = new URL('./data/vps_stock.json', import.meta.url);
const ordersFile = new URL('./data/orders.json', import.meta.url);
const bot = new Telegraf(process.env.BOT_TOKEN);
let stockLock = Promise.resolve();

async function ensureData() {
  await mkdir(dataDir, { recursive: true });
  try { await access(ordersFile, constants.F_OK); } catch { await writeJson(ordersFile, {}); }
  try { await access(stockFile, constants.F_OK); } catch { throw new Error('Buat data/vps_stock.json dari data/vps_stock.example.json'); }
}
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function writeJson(file, value) {
  const temporary = new URL(`${file.pathname}.tmp`, file);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}
function withStockLock(fn) {
  const next = stockLock.then(fn, fn);
  stockLock = next.catch(() => {});
  return next;
}
function paymentUrl(response) {
  return response.qr_url || response.qris_url || response.payment_url || response.url || response.data?.qr_url || response.data?.qris_url || response.data?.payment_url || response.data?.url;
}
function paymentReference(response) {
  return response.reference || response.transaction_id || response.id || response.data?.reference || response.data?.transaction_id || response.data?.id;
}
function paid(response) {
  const status = String(response.status || response.data?.status || '').toLowerCase();
  return ['paid', 'success', 'settlement', 'berhasil'].includes(status) || response.paid === true || response.data?.paid === true;
}
function vpsMessage(vps, index) {
  return `VPS ${index}\n───────────◆───────────\n\nɪɴꜰᴏʀᴍᴀꜱɪ ᴠᴘꜱ\n🌐 IP       : ${vps.ip}\n🔌 PORT     : ${vps.port}\n👤 USERNAME : ${vps.username || 'root'}\n🔐 PASSWORD : ${vps.password}\n\nꜱꜱʜ ᴀᴋꜱᴇꜱ\nssh ${vps.username || 'root'}@${vps.ip} -p ${vps.port}\n\n🟢 Status   : ${vps.status || 'ACTIVE'}`;
}
async function createQris() {
  const response = await fetch(config.topupUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.qrisToken, nominal: 1000 }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `QRIS HTTP ${response.status}`);
  const url = paymentUrl(body);
  const reference = paymentReference(body);
  if (!url || !reference) throw new Error('Respons topup harus berisi URL QRIS dan reference/transaksi ID. Sesuaikan paymentUrl/paymentReference.');
  return { url, reference, raw: body };
}
async function checkPayment(order) {
  if (!config.statusUrl) return false;
  const response = await fetch(config.statusUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.qrisToken, reference: order.reference }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Status QRIS HTTP ${response.status}`);
  return paid(body);
}
async function deliver(orderId) {
  const orders = await readJson(ordersFile);
  const order = orders[orderId];
  if (!order || order.status === 'delivered') return false;
  const stock = await readJson(stockFile);
  if (stock.length < 2) throw new Error('Stok VPS kurang dari 2.');
  const vps = stock.splice(0, 2);
  await writeJson(stockFile, stock);
  order.status = 'delivered';
  order.vps = vps;
  await writeJson(ordersFile, orders);
  await bot.telegram.sendMessage(order.chatId, `PS Berhasil Dibuat\n───────────◆───────────\n\n${vpsMessage(vps[0], 1)}\n\n───────────◆───────────\n\n${vpsMessage(vps[1], 2)}\n\nSimpan baik-baik. Jangan share ke orang lain.`);
  return true;
}
async function verifyAndDeliver(ctx, id) {
  const orders = await readJson(ordersFile);
  const order = orders[id];
  if (!order || order.chatId !== ctx.chat.id) return ctx.answerCbQuery('Pesanan tidak ditemukan.');
  if (order.status === 'delivered') return ctx.answerCbQuery('Data sudah dikirim.');
  if (Date.now() - order.createdAt > config.timeoutMinutes * 60_000) { order.status = 'expired'; await writeJson(ordersFile, orders); return ctx.answerCbQuery('QRIS kedaluwarsa. Buat pesanan baru.'); }
  if (!(await checkPayment(order))) return ctx.answerCbQuery('Belum ada pembayaran.');
  const delivered = await withStockLock(() => deliver(order.id));
  await ctx.answerCbQuery(delivered ? 'Pembayaran berhasil. Data dikirim.' : 'Data sudah dikirim.');
}

bot.start(ctx => ctx.reply('Jual VPS NAT\nRp1.000 = 2 VPS NAT', Markup.inlineKeyboard([[Markup.button.callback('Beli 2 VPS — Rp1.000', 'buy')]])));
bot.action('buy', async ctx => {
  const stock = await readJson(stockFile);
  if (stock.length < 2) return ctx.answerCbQuery('Stok habis.');
  try {
    const qris = await createQris();
    const order = { id: randomUUID(), chatId: ctx.chat.id, reference: qris.reference, createdAt: Date.now(), status: 'pending' };
    const orders = await readJson(ordersFile); orders[order.id] = order; await writeJson(ordersFile, orders);
    await ctx.reply(`Bayar Rp1.000 melalui QRIS ini:\n${qris.url}\n\nReference: ${qris.reference}`, Markup.inlineKeyboard([[Markup.button.callback('Cek pembayaran', `check:${order.id}`)]]));
    await ctx.answerCbQuery();
  } catch (error) { await ctx.answerCbQuery('Gagal membuat QRIS.'); await ctx.reply(`Gagal: ${error.message}`); }
});
bot.action(/^check:(.+)$/, async ctx => { try { await verifyAndDeliver(ctx, ctx.match[1]); } catch (error) { await ctx.answerCbQuery('Gagal cek pembayaran.'); await ctx.reply(`Gagal: ${error.message}`); } });

await ensureData();
bot.launch();
console.log('Bot aktif');
