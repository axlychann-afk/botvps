// lib/rumahotp.js — wrapper API stok nomor buat fitur nokos.
// Rate limit: 5 req / 10 detik -> queue internal 1 req per 2.2 detik biar aman.

const BASE = process.env.RUMAHOTP_BASE || 'https://www.rumahotp.io/api';

// ---- antrian rate-limit sederhana (serial, min gap 2200ms) ----
let _q = Promise.resolve();
function queued(fn) {
  const next = _q.then(async () => {
    const out = await fn();
    await new Promise((s) => setTimeout(s, 2200));
    return out;
  }, async () => {
    const out = await fn();
    await new Promise((s) => setTimeout(s, 2200));
    return out;
  });
  _q = next.catch(() => {});
  return next;
}

function key() {
  const k = process.env.RUMAHOTP_KEY || '';
  if (!k) throw new Error('Kunci API nomor belum diisi. Hubungi admin.');
  return k;
}

function errText(body, fallback) {
  for (const v of [body?.message, body?.error]) {
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      const m = v.message || v.msg || v.error;
      if (typeof m === 'string' && m) return m;
      try { return JSON.stringify(v).slice(0, 300); } catch {}
    }
  }
  return fallback;
}

async function get(path) {
  return queued(async () => {
    const r = await fetch(`${BASE}${path}`, {
      method: 'GET',
      headers: { 'x-apikey': key(), Accept: 'application/json' },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.success === false) {
      throw new Error(errText(body, `API nomor HTTP ${r.status} ${path}`));
    }
    return body.data;
  });
}

// ---- endpoint mentah ----
export const balance = () => get('/v1/user/balance');
export const servicesV2 = () => get('/v2/services');
export const countriesV2 = (serviceId) => get(`/v2/countries?service_id=${encodeURIComponent(serviceId)}`);
export const operatorsV2 = (country, providerId) =>
  get(`/v2/operators?country=${encodeURIComponent(country)}&provider_id=${encodeURIComponent(providerId)}`);
export const createOrderV2 = (numberId, providerId, operatorId) =>
  get(`/v2/orders?number_id=${encodeURIComponent(numberId)}&provider_id=${encodeURIComponent(providerId)}&operator_id=${encodeURIComponent(operatorId)}`);
export const orderStatus = (orderId) =>
  get(`/v1/orders/get_status?order_id=${encodeURIComponent(orderId)}`);
export const setOrderStatus = (orderId, status) =>
  get(`/v1/orders/set_status?order_id=${encodeURIComponent(orderId)}&status=${encodeURIComponent(status)}`);

// ---- deposit / top up saldo nomor (min 2000) ----
export const createDeposit = (amount, paymentId = 'qris') =>
  get(`/v2/deposit/create?amount=${encodeURIComponent(amount)}&payment_id=${encodeURIComponent(paymentId)}`);
export const depositStatus = (depositId) =>
  get(`/v2/deposit/get_status?deposit_id=${encodeURIComponent(depositId)}`);
export const cancelDeposit = (depositId) =>
  get(`/v1/deposit/cancel?deposit_id=${encodeURIComponent(depositId)}`);

const DEP_PAID = new Set(['paid', 'success', 'settlement', 'berhasil', 'sukses', 'lunas', 'done', 'completed', 'complete', 'ok', 'approved', 'settled']);

export function depositPaid(dep) {
  if (!dep || typeof dep !== 'object') return false;
  const s = String(dep.status || '').toLowerCase();
  return DEP_PAID.has(s);
}

// ---- cache katalog (services 6 jam, countries 30 mnt) ----
const _cache = { services: null, servicesAt: 0, countries: new Map() };
const HOUR = 3600_000;

export async function cachedServices() {
  if (_cache.services && Date.now() - _cache.servicesAt < 6 * HOUR) return _cache.services;
  const d = await servicesV2();
  _cache.services = d;
  _cache.servicesAt = Date.now();
  return d;
}

export async function cachedCountries(serviceId, force = false) {
  const k = String(serviceId);
  const hit = _cache.countries.get(k);
  if (!force && hit && Date.now() - hit.at < 60_000) return hit.data;
  const d = await countriesV2(serviceId);
  _cache.countries.set(k, { data: d, at: Date.now() });
  return d;
}

// ---- katalog jualan: WA + TG, Indo only ----
export const NOKOS_CATALOG = [
  { serviceId: 13, label: 'WhatsApp', emoji: '💬' },
  { serviceId: 4, label: 'Telegram', emoji: '✈️' },
];

export function sellPrice(dasar) {
  return Number(dasar || 0) + Number(process.env.NOKOS_MARKUP || 1000);
}

export function formatRupiah(n) {
  return `Rp${Number(n || 0).toLocaleString('id-ID')}`;
}

// Cari stok termurah yg ready di negara Indo.
export function cheapestProvider(countryRow) {
  const list = (countryRow?.pricelist || []).filter((p) => p.available !== false && Number(p.stock) > 0);
  list.sort((a, b) => Number(a.price) - Number(b.price));
  return list[0] || null;
}

export async function indoRow(serviceId, force = false) {
  const rows = await cachedCountries(serviceId, force);
  return (rows || []).find((r) => r.iso_code === 'id' || /indonesia/i.test(r.name || ''));
}

// Extract kode OTP dari payload get_status (bentuk field bisa beda2).
export function extractOtp(statusData) {
  if (!statusData) return null;
  const blob = JSON.stringify(statusData);
  const m = blob.match(/(?:otp|code|sms|pesan)[^0-9]{0,20}(\d{4,8})/i) || blob.match(/(\d{4,8})/);
  return m ? m[1] : null;
}
