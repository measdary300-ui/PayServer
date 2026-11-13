// ============================================================
// PayServer v1.1.3 — ABA PayWay KHQR auto top-up server
// v1.1.3: + public weekly keys (1 key = up to 10 devices,
//   each device valid N days from ITS OWN activation).
//   POST /api/license/create accepts maxDevices (1–10) +
//   activationDays (1–365): such a key has NO fixed expiry
//   (expiresAt null, activationBased true); each device's
//   expiry is stored in activations[] as {machineId,
//   activatedAt, expiresAt}. Verify looks the device up in
//   activations[] and binds a new device while slots remain.
//   Legacy keys (no activationDays) use the v1.1.2 flow
//   EXACTLY as before (1 PC at a time + moved-PC block).
//   All per-device expiry logic lives in findActivation /
//   activateDevice, so switching to per-KEY expiry later is
//   a small change in one place.
// v1.1.0: + license endpoints (1 Key = 1 PC, online verify)
//   for the SR Downloader PC app (Electron).
//   POST /api/license/create | /verify | /unbind
//   GET  /api/license/list  (+ /health reports license/sheets)
//   Keys are stored in licenses.json and (optionally) logged to a
//   Google Sheet. PayWay / top-up / wallet code is UNCHANGED.
// v1.0.4: ចំនួន $0.10 សម្រាប់សាកបង់តិចៗ + expires_in 180 → 360 វិនាទី
//   (6 នាទី — ត្រូវនឹង PayWay lifetime) ដើម្បីឲ្យ Mini App poll រហូតដល់
//   QR ផុតកំណត់ពិត ទើបលោត popup ប្រាប់។
// for the Telegram Drama Mini App (Drama mini app)
// ------------------------------------------------------------
// តើ server នេះធ្វើអ្វី?
//   1. Mini App សុំបង្កើតការបង់ប្រាក់ (Top Up $X)
//   2. Server បង្កើត KHQR ជាមួយ ABA PayWay → ផ្ញើ QR មក Mini App
//   3. អ្នកប្រើស្កេន QR បង់លុយតាម ABA app
//   4. Mini App សួរ status → Server សួរ PayWay ថាបង់រួចឬនៅ
//   5. បើ PayWay ប្រាប់ថា APPROVED → Server បញ្ចូលលុយទៅ wallet
//      ដោយស្វ័យប្រវត្តិ (អត់ត្រូវការ admin ពិនិត្យ screenshot ទៀត!)
// ------------------------------------------------------------
// Env vars (ដាក់ក្នុង Railway Variables — កុំដាក់ក្នុង code!):
//   PAYWAY_BASE_URL    — default https://checkout.payway.com.kh/
//                        sandbox: https://checkout-sandbox.payway.com.kh/
//   PAYWAY_MERCHANT_ID — Merchant ID ពី ABA PayWay merchant portal
//   PAYWAY_API_KEY     — API Key ពី ABA PayWay merchant portal
//   PUBLIC_URL         — (optional) public URL របស់ server នេះ
//                        (ប្រើជា return_url ឲ្យ PayWay)
//   PORT               — default 3002
//   LICENSE_ADMIN_SECRET — secret for /api/license/create, /unbind,
//                        /list (header X-Admin-Secret). Generate with
//                        crypto.randomBytes(32).toString('hex').
//   GOOGLE_SERVICE_ACCOUNT_JSON — (optional) service-account JSON
//                        as a single-line JSON string.
//   SHEET_ID           — (optional) Google Sheet ID for license log.
//                        Without these two, Sheets logging is off
//                        and licenses.json still works fully.
// ------------------------------------------------------------
// Stores (local JSON — សម្រាប់ production ប្រើ Railway Volume!):
//   wallets.json — {[telegramId]: {balance, vip, txns:[{tran_id,amount,at}]}}
//   topups.json  — {[tran_id]: {telegramId, amount, status, credited, createdAt}}
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { PayWayClient } = require('payway-ts');

// ---------- config ----------
const PORT = parseInt(process.env.PORT || '3002', 10);
const PAYWAY_BASE_URL = process.env.PAYWAY_BASE_URL || 'https://checkout.payway.com.kh/';
const PAYWAY_MERCHANT_ID = (process.env.PAYWAY_MERCHANT_ID || '').trim();
const PAYWAY_API_KEY = (process.env.PAYWAY_API_KEY || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
const TOPUP_EXPIRY_MS = 10 * 60 * 1000; // 10 នាទី — បន្ទាប់ពីហ្នឹង topup នឹង expired
const TOPUP_QR_EXPIRES_IN = 360;        // 360 វិនាទី (6 នាទី) — ត្រូវនឹង PayWay lifetime 6 នាទី; Mini App poll រហូតដល់ពេលនេះ
const ALLOWED_AMOUNTS = [0.1, 1, 2, 5, 10, 20, 50, 100];

// ---------- PayWay client (null បើគ្មាន credentials) ----------
let payway = null;
if (PAYWAY_MERCHANT_ID && PAYWAY_API_KEY) {
  payway = new PayWayClient(PAYWAY_BASE_URL, PAYWAY_MERCHANT_ID, PAYWAY_API_KEY);
  console.log('[PayServer] PayWay configured. Base URL:', PAYWAY_BASE_URL);
} else {
  console.log('[PayServer] WARNING: PAYWAY_MERCHANT_ID / PAYWAY_API_KEY not set — PayWay calls will fail cleanly, server still runs.');
}

// ---------- License config (v1.1.0 — SR Downloader 1 Key = 1 PC) ----------
// LICENSE_ADMIN_SECRET — set in Railway Variables only, never in code.
// GOOGLE_SERVICE_ACCOUNT_JSON + SHEET_ID — optional; without them the
// server runs WITHOUT Google Sheets (licenses.json still works fully).
const LICENSE_ADMIN_SECRET = (process.env.LICENSE_ADMIN_SECRET || '').trim();
const SHEET_ID = (process.env.SHEET_ID || '').trim();
const SHEET_HEADERS = ['Key', 'Buyer', 'Telegram', 'Machine ID', 'Created', 'Expires', 'Status'];

// googleapis is optional at runtime: if it is not installed (or the env
// vars are missing) Sheets logging is simply off — never crash the server.
let google = null;
try { ({ google } = require('googleapis')); } catch (_) { google = null; }
let sheetsClient = null; // lazy: sheets.spreadsheets.values (real or injected fake)
let sheetsHeadersEnsured = false;
function sheetsConfigured() {
  return !!(google && SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}
function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!sheetsConfigured()) return null;
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    sheetsClient = google.sheets({ version: 'v4', auth }).spreadsheets.values;
  } catch (e) {
    console.warn('[PayServer] WARNING: could not init Google Sheets client:', e.message, '— Sheets logging off.');
    sheetsClient = null;
  }
  return sheetsClient;
}
if (!LICENSE_ADMIN_SECRET) {
  console.log('[PayServer] WARNING: LICENSE_ADMIN_SECRET not set — /api/license/create, /unbind, /list will return 401.');
}
if (!sheetsConfigured()) {
  console.log('[PayServer] WARNING: Google Sheets not configured (need GOOGLE_SERVICE_ACCOUNT_JSON + SHEET_ID) — license log stays in licenses.json only.');
}

// ---------- JSON stores (atomic write, tolerate missing/corrupt) ----------
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
const TOPUPS_FILE = path.join(__dirname, 'topups.json');

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
    console.warn(`[PayServer] WARNING: ${path.basename(file)} is not an object — starting empty.`);
    return fallback;
  } catch (e) {
    console.warn(`[PayServer] WARNING: could not read ${path.basename(file)} (${e.message}) — starting empty.`);
    return fallback;
  }
}

// សរសេរ atomic: សរសេរ temp file រួច rename (មិនខូច file បើ server crash ពេលសរសេរ)
function saveJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadWallets() { return loadJson(WALLETS_FILE, {}); }
function loadTopups() { return loadJson(TOPUPS_FILE, {}); }
function saveWallets(w) { saveJson(WALLETS_FILE, w); }
function saveTopups(t) { saveJson(TOPUPS_FILE, t); }

// ---------- Licenses store (v1.1.3) ----------
// licenses.json — { NORMALIZED_KEY: { key (normalized), displayKey
//   (dashed, human-readable), buyer, telegram, createdAt, expiresAt
//   (ISO string or null = lifetime), machineId (null until bound),
//   boundAt, previousMachineId, blockedMachineIds (PCs the key moved
//   away from — blocked until admin unbind), rebindCount, rebindHistory,
//   status: 'active'|'revoked', lastVerifiedAt,
//   maxDevices (default 1), activationDays (null = legacy fixed-expiry
//   key), activationBased (true when activationDays was given at
//   create), activations: [{ machineId, activatedAt, expiresAt }]
//   — one entry per device, each with ITS OWN expiry
//   (activatedAt + activationDays). Legacy records without the new
//   fields keep working: missing maxDevices = 1, missing
//   activations = [], missing activationBased = false. } }
const LICENSES_FILE = path.join(__dirname, 'licenses.json');
function loadLicenses() { return loadJson(LICENSES_FILE, {}); }
function saveLicenses(l) { saveJson(LICENSES_FILE, l); }

function getWallet(wallets, telegramId) {
  const id = String(telegramId);
  if (!wallets[id]) wallets[id] = { balance: 0, vip: false, txns: [] };
  return wallets[id];
}

// ---------- credit (idempotent — កុំឲ្យបញ្ចូលលុយ 2 ដង!) ----------
// ចំណុចសំខាន់៖ mark topup ว่า credited ហើយ save topups.json *មុន*
// បញ្ចូលលុយទៅ wallet — បើ server crash នៅចន្លោះ ក៏មិនបញ្ចូល 2 ដងដែរ។
function creditTopup(tranId) {
  const topups = loadTopups();
  const topup = topups[tranId];
  if (!topup) return { ok: false, error: 'not found' };
  if (topup.credited) {
    // បញ្ចូលរួចហើយ — ត្រឡប់ balance បច្ចុប្បន្នវិញ (អត់បញ្ចូលម្តងទៀត)
    const wallets = loadWallets();
    const w = getWallet(wallets, topup.telegramId);
    return { ok: true, already: true, balance: w.balance };
  }
  // 1) mark credited FIRST
  topup.status = 'paid';
  topup.credited = true;
  topup.creditedAt = new Date().toISOString();
  saveTopups(topups);
  // 2) បន្ទាប់មកបញ្ចូលលុយទៅ wallet
  const wallets = loadWallets();
  const w = getWallet(wallets, topup.telegramId);
  w.balance = (w.balance || 0) + topup.amount;
  w.txns = w.txns || [];
  w.txns.push({ tran_id: tranId, amount: topup.amount, at: new Date().toISOString() });
  saveWallets(wallets);
  console.log(`[PayServer] Credited $${topup.amount} to ${topup.telegramId} (tran ${tranId}). New balance: $${w.balance}`);
  return { ok: true, already: false, balance: w.balance };
}

// ---------- helpers ----------
let tranSeq = 0;
function makeTranId(telegramId) {
  // tran_id ត្រូវ ≤ 20 តួ (ABA /generate-qr limit) — D + 6 ខ្ទង់ចុងក្រោយ
  // របស់ telegramId + timestamp base36 + counter 2 តួ (អតិបរមា 17 តួ).
  // Counter ធានាថា unique សូម្បីបង្កើតច្រើនដងក្នុង 1ms ដូចគ្នា.
  const seq = (tranSeq++ % 1296).toString(36).padStart(2, '0');
  return `D${String(telegramId).slice(-6)}${Date.now().toString(36)}${seq}`;
}

// ទាញ message ដែលអានបានពី PayWay error (អត់ leak api key!)
function paywayErrorMessage(err) {
  try {
    const body = err && err.body;
    if (body && typeof body === 'object') {
      if (body.status && body.status.message) return String(body.status.message);
      if (body.message) return String(body.message);
    }
    if (typeof body === 'string' && body.length < 300) return body;
    if (err && err.message) return String(err.message).slice(0, 200);
  } catch (_) { /* ignore */ }
  return 'PayWay error';
}

// ទាញ QR / deeplink / checkout URL ពី PayWay create response.
// ហេតុផល៖ PayWay ប្តូរទម្រង់ response តាម endpoint/environment —
//   flat (top-level: qr_string, abapay_deeplink, checkout_qr_url)
//   ឬ nested (ក្រោម `data`, ដូច check-transaction response),
//   status.code អាចជា string '00' ឬ number 0.
// ដូច្នេះរកគ្រប់កន្លែងដែលអាច — កុំបរាជ័យព្រោះតែ key នៅកន្លែងផ្សេង!
function extractPaywayQr(result) {
  if (!result || typeof result !== 'object') return { okCode: false, code: null, msg: '', qrString: null, deeplink: null, checkoutUrl: null };
  const data = (result.data && typeof result.data === 'object') ? result.data : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = (result[k] !== undefined && result[k] !== null && result[k] !== '') ? result[k]
        : (data[k] !== undefined && data[k] !== null && data[k] !== '') ? data[k] : null;
      if (v !== null) return v;
    }
    return null;
  };
  const codeRaw = (result.status && result.status.code !== undefined && result.status.code !== null)
    ? result.status.code
    : (data.status && data.status.code !== undefined && data.status.code !== null ? data.status.code : null);
  const code = (codeRaw === null || codeRaw === undefined) ? null : String(codeRaw);
  const msg = (result.status && result.status.message)
    ? String(result.status.message)
    : (data.status && data.status.message ? String(data.status.message) : '');
  return {
    okCode: code === '00' || code === '0',
    code, msg,
    qrString: pick('qr_string', 'qrString', 'qr'),
    qrImage: pick('qrImage', 'qr_image'),
    deeplink: pick('abapay_deeplink', 'deeplink'),
    checkoutUrl: pick('checkout_qr_url', 'checkout_url', 'qr_url')
  };
}

// ---------- /generate-qr (QR API — វិធីបង្កើត KHQR ដោយផ្ទាល់) ----------
// POST JSON ទៅ /api/payment-gateway/v1/payments/generate-qr
// Response: {status:{code:"0",message:""}, qrString, qrImage (PNG data URL
//   ពី ABA), abapay_deeplink, tran_id}
// Hash (§8.1, 18 fields, base64 HMAC-SHA512): req_time, merchant_id, tran_id,
// amount, items, first_name, last_name, email, phone, purchase_type,
// payment_option, callback_url, return_deeplink, currency, custom_fields,
// return_params, payout, lifetime, qr_image_template
// (field ដែលអត់ប្រើ = '' ក្នុង hash, និង omit ចេញពី body ទាំងស្រុង)
function paywayReqTime(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getUTCFullYear()).padStart(4, '0') + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
    + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

function generateQrHash(values) {
  return crypto.createHmac('sha512', PAYWAY_API_KEY).update(values.join('')).digest('base64');
}

// បង្កើត body សម្រាប់ /generate-qr (JSON).
// ចំណាំសំខាន់៖ first_name/last_name/email/phone ត្រូវផ្ញើជា "" (Python SDK
// "required by api" — v1.0.2 omit វាចោល PayWay ត្រឡប់ code 96
// "Invalid merchant data"). Hash (§8.1) មិនផ្លាស់ប្តូរទេ ព្រោះ ""
// មិនបន្ថែមអ្វីទៅ concatenation.
function buildGenerateQrBody(tranId, amount) {
  const reqTime = paywayReqTime();
  const itemsB64 = Buffer.from(JSON.stringify([{ name: 'Wallet Top Up', price: amount, quantity: 1 }])).toString('base64');
  const callbackB64 = PUBLIC_URL ? Buffer.from(PUBLIC_URL + '/api/payway/callback').toString('base64') : '';
  const lifetime = 6; // នាទី — Python SDK default (min 3)
  const template = 'template3_color';
  const hash = generateQrHash([
    reqTime, PAYWAY_MERCHANT_ID, tranId, String(amount), itemsB64,
    '', '', '', '', // first_name, last_name, email, phone
    'purchase', 'abapay_khqr', callbackB64, '', // purchase_type, payment_option, callback_url, return_deeplink
    'USD', '', '', '', // currency, custom_fields, return_params, payout
    String(lifetime), template
  ]);
  const body = {
    req_time: reqTime,
    merchant_id: PAYWAY_MERCHANT_ID,
    tran_id: tranId,
    amount: amount,
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    items: itemsB64,
    purchase_type: 'purchase',
    payment_option: 'abapay_khqr',
    currency: 'USD',
    lifetime: lifetime,
    qr_image_template: template,
    hash: hash
  };
  if (callbackB64) body.callback_url = callbackB64;
  return body;
}

async function createQrViaGenerateQr(tranId, amount) {
  const body = buildGenerateQrBody(tranId, amount);
  const url = PAYWAY_BASE_URL.replace(/\/$/, '') + '/api/payment-gateway/v1/payments/generate-qr';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'PayServer/1.0.3 (aba-payway)' },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  try { console.log(`[PayServer] generate-qr raw for ${tranId}: ${text.slice(0, 1500)}`); } catch (_) {}
  let result = null;
  try {
    result = JSON.parse(text);
  } catch (_) {
    // PayWay ត្រឡប់ HTML (error page / maintenance) — log snippet ហើយបរាជ័យ
    const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`PayWay generate-qr returned HTML (not JSON): ${snippet || '(empty)'}`);
  }
  return result;
}

// ទាញ URLs ទាំងអស់ចេញពី HTML (សម្រាប់ពេល PayWay ត្រឡប់ checkout page)
function extractUrlsFromHtml(html) {
  const urls = [];
  const re = /https?:\/\/[^\s"'<>]+/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!urls.includes(m[0])) urls.push(m[0]);
    if (urls.length >= 10) break;
  }
  return urls;
}

// /purchase fallback — ផ្ញើជា application/x-www-form-urlencoded
// (តាម reference project §5.2 — SDK ផ្ញើ multipart ដែល PayWay
// ត្រឡប់ HTML checkout page មកវិញជំនួស JSON). ត្រឡប់ extractPaywayQr
// result (ឬ null បើគ្មាន QR) — និង log raw response សម្រាប់ debug.
async function createQrViaPurchase(tranId, amount) {
  const payload = payway.buildTransactionPayload({
    tran_id: tranId,
    payment_option: 'abapay_khqr',
    amount: amount,
    currency: 'USD',
    lifetime: 10,
    ...(PUBLIC_URL ? { return_url: PUBLIC_URL + '/api/payway/callback' } : {})
  });
  const formBody = new URLSearchParams();
  for (const [k, v] of Object.entries(payload.fields)) formBody.append(k, String(v));
  const resp = await fetch(payload.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'PayServer/1.0.3 (aba-payway)' },
    body: formBody.toString()
  });
  const text = await resp.text();
  let result = null;
  try {
    result = JSON.parse(text);
  } catch (_) {
    // PayWay ត្រឡប់ HTML checkout page — រក checkout/qr URL ក្នុងវា
    const urls = extractUrlsFromHtml(text);
    console.warn(`[PayServer] /purchase returned HTML for ${tranId}: urls=${JSON.stringify(urls)}`);
    const checkout = urls.find(u => /checkout|payway|qr/i.test(u));
    if (checkout) return { okCode: true, code: '0', msg: '', qrString: null, qrImage: null, deeplink: null, checkoutUrl: checkout };
    return null;
  }
  try { console.log(`[PayServer] /purchase raw for ${tranId}: ${text.slice(0, 1500)}`); } catch (_) {}
  return extractPaywayQr(result);
}

// ---------- Licenses (v1.1.2 — SR Downloader: 1 Key = 1 PC AT A TIME) ----------
// Keys float: any valid key may move to a new PC when online (re-bind
// replaces the old binding, logged in rebindCount/rebindHistory).
// v1.1.2: the PC a key moved AWAY from is BLOCKED for that key
// (blockedMachineIds) — it can never use the key again until an admin
// unbinds it. The block only takes effect when that PC goes ONLINE
// (an offline PC keeps working until its 7-day grace ends —
// there is no way to reach an offline PC).
// Offline use still works 7 days from the last successful verify.
// Key format: SRD-XXXX-XXXX-XXXX-XXXX, uppercase alphanumerics excluding
// confusing chars 0/O and 1/I.
// The Electron app NORMALIZES keys before sending (trims, strips
// dashes/spaces, uppercases), so the server compares keys ONLY in
// normalized form: strip all dashes/spaces, uppercase.
//   display form (dashed, human-readable): SRD-ABCD-EFGH-IJKL-MNOP
//   stored/canonical form (normalized):    SRDABCDEFGHIJKLMNOP
// licenses.json is keyed by the NORMALIZED key; each record also keeps
// displayKey (dashed) for humans and for the Google Sheet row.
const LICENSE_KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  return key.replace(/[-\s]/g, '').toUpperCase();
}
function generateLicenseKey() {
  const rand = crypto.randomBytes(16);
  let out = 'SRD';
  for (let g = 0; g < 4; g++) {
    out += '-';
    for (let i = 0; i < 4; i++) out += LICENSE_KEY_CHARS[rand[g * 4 + i] % LICENSE_KEY_CHARS.length];
  }
  return out;
}

// Parse expiry input into an ISO string or null (lifetime).
// Accepts: ISO date string, DD/MM/YYYY, or expiresInDays (number).
// Returns { expiresAt } on success or { error } on bad input.
function parseLicenseExpiry(body) {
  const b = body || {};
  if (b.expiresAt !== undefined && b.expiresAt !== null && b.expiresAt !== '') {
    const raw = String(b.expiresAt).trim();
    const dm = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // DD/MM/YYYY
    if (dm) {
      const d = new Date(Date.UTC(+dm[3], +dm[2] - 1, +dm[1], 0, 0, 0));
      if (d.getUTCFullYear() !== +dm[3] || d.getUTCMonth() !== +dm[2] - 1 || d.getUTCDate() !== +dm[1]) {
        return { error: 'expiresAt is not a valid DD/MM/YYYY date' };
      }
      return { expiresAt: d.toISOString() };
    }
    const d = new Date(raw); // ISO date string
    if (isNaN(d.getTime())) return { error: 'expiresAt is not a valid date' };
    return { expiresAt: d.toISOString() };
  }
  if (b.expiresInDays !== undefined && b.expiresInDays !== null && b.expiresInDays !== '') {
    const n = Number(b.expiresInDays);
    if (!Number.isFinite(n) || n <= 0) return { error: 'expiresInDays must be a positive number' };
    return { expiresAt: new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString() };
  }
  return { expiresAt: null }; // lifetime
}

function isLicenseExpired(lic) {
  return !!(lic.expiresAt && Date.now() > new Date(lic.expiresAt).getTime());
}

// ---------- Activation-based keys (v1.1.3 — public weekly keys) ----------
// ALL per-device expiry logic lives in these two helpers, so the model
// can change in one place later (e.g. per-KEY expiry: give every device
// the key's first activationAt + activationDays instead of its own).
// A license is activation-based when lic.activationBased is true
// (set at create time by activationDays). Legacy keys never reach here.
function findActivation(lic, machineId) {
  const acts = Array.isArray(lic.activations) ? lic.activations : [];
  return acts.find((a) => a && a.machineId === machineId) || null;
}
function activateDevice(lic, machineId, now) {
  const acts = Array.isArray(lic.activations) ? lic.activations : [];
  const act = {
    machineId,
    activatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + lic.activationDays * 24 * 60 * 60 * 1000).toISOString()
  };
  acts.push(act);
  lic.activations = acts;
  return act;
}
// Max devices for a key — legacy records without the field default to 1.
function licenseMaxDevices(lic) {
  return Number.isInteger(lic.maxDevices) && lic.maxDevices > 0 ? lic.maxDevices : 1;
}

// Admin check for /api/license/create, /unbind, /list.
// Header X-Admin-Secret must equal LICENSE_ADMIN_SECRET.
function requireLicenseAdmin(req, res) {
  const sent = (req.headers['x-admin-secret'] || '').trim();
  if (!LICENSE_ADMIN_SECRET || !sent || sent !== LICENSE_ADMIN_SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized — invalid or missing X-Admin-Secret' });
    return false;
  }
  return true;
}

// ---------- Google Sheets license log (all errors caught, never crash) ----------
// Sheet columns (row 1 headers, exactly):
//   Key | Buyer | Telegram | Machine ID | Created | Expires | Status
// Machine ID column (D) for the Sheet. Legacy key: the single bound
// machineId. Activation-based key: all activated devices, comma-separated
// (column layout unchanged: Key|Buyer|Telegram|Machine ID|Created|Expires|Status).
function licenseSheetMachineId(lic) {
  if (lic.activationBased) {
    const acts = Array.isArray(lic.activations) ? lic.activations : [];
    return acts.map((a) => a && a.machineId).filter(Boolean).join(', ');
  }
  return lic.machineId || '';
}
function licenseToSheetRow(lic) {
  // Sheet shows the dashed human-readable key (displayKey).
  // Activation-based key: Expires column reads "7d from activation"
  // (no fixed date — each device gets its own 7 days).
  const expires = lic.activationBased
    ? (lic.activationDays ? lic.activationDays + 'd from activation' : 'from activation')
    : (lic.expiresAt || '');
  return [lic.displayKey || lic.key, lic.buyer || '', lic.telegram || '', licenseSheetMachineId(lic),
    lic.createdAt || '', expires, lic.status || 'active'];
}
async function ensureSheetHeaders(client) {
  if (sheetsHeadersEnsured) return;
  try {
    const got = await client.get({ spreadsheetId: SHEET_ID, range: 'A1:G1' });
    const row = (got && got.data && got.data.values && got.data.values[0]) || [];
    const same = SHEET_HEADERS.every((h, i) => row[i] === h);
    if (!same) {
      await client.update({ spreadsheetId: SHEET_ID, range: 'A1:G1', valueInputOption: 'RAW', resource: { values: [SHEET_HEADERS] } });
    }
    sheetsHeadersEnsured = true;
  } catch (e) {
    console.warn('[PayServer] Sheets: could not ensure headers:', e.message);
  }
}
async function sheetsAppendLicense(lic) {
  const client = getSheetsClient();
  if (!client) return;
  try {
    await ensureSheetHeaders(client);
    await client.append({
      spreadsheetId: SHEET_ID, range: 'A:G',
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      resource: { values: [licenseToSheetRow(lic)] }
    });
  } catch (e) {
    console.warn('[PayServer] Sheets: append failed for', lic.key, '-', e.message);
  }
}
async function sheetsUpdateBind(lic) {
  const client = getSheetsClient();
  if (!client) return;
  try {
    const got = await client.get({ spreadsheetId: SHEET_ID, range: 'A:A' });
    const rows = (got && got.data && got.data.values) || [];
    let rowNum = -1;
    for (let i = 0; i < rows.length; i++) {
      // Sheet column A holds the dashed key — compare normalized.
      if (rows[i] && normalizeKey(rows[i][0]) === lic.key) { rowNum = i + 1; break; } // 1-based
    }
    if (rowNum < 0) { // key not in sheet (e.g. created before Sheets) — append it
      await sheetsAppendLicense(lic);
      return;
    }
    await client.update({ spreadsheetId: SHEET_ID, range: `D${rowNum}`, valueInputOption: 'RAW', resource: { values: [[licenseSheetMachineId(lic)]] } });
    await client.update({ spreadsheetId: SHEET_ID, range: `G${rowNum}`, valueInputOption: 'RAW', resource: { values: [[lic.status || 'active']] } });
  } catch (e) {
    console.warn('[PayServer] Sheets: bind update failed for', lic.key, '-', e.message);
  }
}
// Test hook: inject a fake Sheets client (used by tests/license.test.js).
// Passing null resets to the real client (re-resolved lazily).
function __setSheetsClient(client) { sheetsClient = client; sheetsHeadersEnsured = false; }

// ---------- app ----------
const app = express();
app.use(cors()); // v1: allow all origins (Mini App នៅលើ GitHub Pages)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---------- GET /health ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, payway: payway ? 'configured' : 'missing', license: true, sheets: sheetsConfigured(), time: new Date().toISOString() });
});

// ---------- POST /api/topup/create ----------
app.post('/api/topup/create', async (req, res) => {
  const telegramId = req.body && req.body.telegramId;
  const amount = req.body && req.body.amount;

  if (telegramId === undefined || telegramId === null || telegramId === '') {
    return res.status(400).json({ ok: false, error: 'telegramId is required / ត្រូវការ telegramId' });
  }
  if (typeof amount !== 'number' || !ALLOWED_AMOUNTS.includes(amount)) {
    return res.status(400).json({
      ok: false,
      error: `amount must be one of ${ALLOWED_AMOUNTS.join(', ')} / ចំនួនលុយត្រូវតែជា ${ALLOWED_AMOUNTS.join(', ')} ដុល្លារ`
    });
  }
  if (!payway) {
    return res.status(503).json({
      ok: false,
      error: 'PayWay credentials not set — សូមដាក់ PAYWAY_MERCHANT_ID និង PAYWAY_API_KEY ក្នុង Railway Variables សិន'
    });
  }

  const tranId = makeTranId(telegramId);
  // 1) សាក QR API (/generate-qr) មុន — API ដែលបង្កើត KHQR ដោយផ្ទាល់
  let qr = null;
  let lastError = '';
  try {
    const genResult = await createQrViaGenerateQr(tranId, amount);
    const q1 = extractPaywayQr(genResult);
    if (q1.okCode || q1.qrString || q1.qrImage || q1.checkoutUrl) qr = q1;
    else lastError = q1.msg || 'generate-qr did not return a QR';
  } catch (e) {
    lastError = e && e.message ? String(e.message).slice(0, 300) : 'generate-qr failed';
    console.warn(`[PayServer] generate-qr failed for ${tranId}: ${lastError}`);
    qr = null;
  }
  // 2) បើ QR API បរាជ័យ → fallback ទៅ /purchase (urlencoded)
  if (!qr) {
    try {
      const q2 = await createQrViaPurchase(tranId, amount);
      if (q2 && (q2.okCode || q2.qrString || q2.qrImage || q2.checkoutUrl)) qr = q2;
      else lastError = (q2 && q2.msg) || 'purchase did not return a QR';
    } catch (e) {
      lastError = paywayErrorMessage(e);
      console.warn(`[PayServer] /purchase failed for ${tranId}: ${lastError}`);
    }
  }
  if (!qr || (!qr.qrString && !qr.qrImage && !qr.checkoutUrl)) {
    return res.status(502).json({ ok: false, error: `PayWay: ${lastError || 'did not return a QR'} / PayWay មិនបានបង្កើត QR សូមសាកម្តងទៀត ឬប្រើវិធី Manual` });
  }

  // រក្សា pending record
  const topups = loadTopups();
  topups[tranId] = {
    telegramId: String(telegramId),
    amount: amount,
    status: 'pending',
    credited: false,
    createdAt: new Date().toISOString()
  };
  saveTopups(topups);

  // QR image: ប្រើ qrImage ពី ABA (PNG) បើមាន, បើអត់ render ពី qrString
  let qrImage = qr.qrImage || null;
  if (!qrImage && qr.qrString) qrImage = await QRCode.toDataURL(qr.qrString, { margin: 1, width: 400 });

  return res.json({
    ok: true,
    tran_id: tranId,
    qr_image: qrImage,
    pay_via_url: !qrImage && !!qr.checkoutUrl,
    abapay_deeplink: qr.deeplink || null,
    checkout_qr_url: qr.checkoutUrl || null,
    amount: amount,
    expires_in: TOPUP_QR_EXPIRES_IN
  });
});

// ---------- GET /api/topup/status/:tranId ----------
app.get('/api/topup/status/:tranId', async (req, res) => {
  const tranId = req.params.tranId;
  const topups = loadTopups();
  const topup = topups[tranId];
  if (!topup) {
    return res.status(404).json({ ok: false, error: 'not found / រកមិនឃើញ transaction នេះទេ' });
  }

  // បញ្ចូលរួចហើយ → ត្រឡប់ balance
  if (topup.credited || topup.status === 'paid') {
    const wallets = loadWallets();
    const w = getWallet(wallets, topup.telegramId);
    return res.json({ ok: true, status: 'paid', amount: topup.amount, balance: w.balance });
  }

  // ផុត 10 នាទីហើយ នៅ pending → expired (ហើយសាក close នៅ PayWay)
  const ageMs = Date.now() - new Date(topup.createdAt).getTime();
  if (ageMs > TOPUP_EXPIRY_MS) {
    topup.status = 'expired';
    saveTopups(topups);
    if (payway) {
      try {
        await payway.execute(payway.buildCloseTransactionPayload(tranId));
        console.log(`[PayServer] Closed expired tran ${tranId} at PayWay.`);
      } catch (_) { /* best-effort — ignore close errors */ }
    }
    return res.json({ ok: true, status: 'expired', amount: topup.amount });
  }

  // សួរ PayWay ថាបង់រួចឬនៅ
  if (!payway) {
    return res.json({ ok: true, status: 'pending', amount: topup.amount, note: 'PayWay not configured' });
  }
  try {
    const result = await payway.execute(payway.buildCheckTransactionPayload(tranId));
    const paid = result && result.data && result.data.payment_status === 'APPROVED';
    if (paid) {
      const credited = creditTopup(tranId);
      return res.json({ ok: true, status: 'paid', amount: topup.amount, balance: credited.balance });
    }
    return res.json({ ok: true, status: 'pending', amount: topup.amount });
  } catch (err) {
    // PayWay check ខុស — កុំរាយការណ៍ថា paid! ត្រឡប់ pending ឲ្យ Mini App សាកម្តងទៀត
    console.warn(`[PayServer] PayWay check failed for ${tranId}: ${paywayErrorMessage(err)}`);
    return res.json({ ok: true, status: 'pending', amount: topup.amount, note: 'check failed, retry' });
  }
});

// ---------- GET /api/wallet/:telegramId ----------
app.get('/api/wallet/:telegramId', (req, res) => {
  const wallets = loadWallets();
  const w = getWallet(wallets, req.params.telegramId);
  res.json({ ok: true, balance: w.balance || 0, vip: !!w.vip });
});

// ---------- POST /api/payway/callback ----------
// Webhook receiver សម្រាប់ PayWay return_url/callbacks.
// ចំណាំ៖ កុំ credit លុយពី callback នេះដោយផ្ទាល់! Callback អាចក្លែងបាន —
// status check ទៅ PayWay ខ្លួនឯងទេដែលជា source of truth.
// Callback នេះគ្រាន់តែ mark ថា PayWay បានប្រាប់មក — crediting កើតឡើង
// នៅពេល Mini App សួរ /api/topup/status (ដែលសួរ PayWay ផ្ទាល់)។
app.post('/api/payway/callback', (req, res) => {
  const body = req.body || {};
  // Log ដោយ redacted (លុប field ដែលមើលទៅដូច secret)
  const safe = {};
  for (const [k, v] of Object.entries(body)) {
    if (/key|secret|password|token/i.test(k)) continue;
    safe[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
  }
  console.log('[PayServer] PayWay callback:', JSON.stringify(safe));

  const tranId = body.tran_id || body.tranId || (body.data && body.data.tran_id);
  const paidHint = body.status === 'APPROVED'
    || body.payment_status === 'APPROVED'
    || (body.data && body.data.payment_status === 'APPROVED')
    || (body.status && typeof body.status === 'object' && body.status.code === '00');
  if (tranId && paidHint) {
    const topups = loadTopups();
    const topup = topups[tranId];
    if (topup && !topup.credited) {
      topup.callbackSeen = true;
      topup.callbackAt = new Date().toISOString();
      saveTopups(topups);
      console.log(`[PayServer] Callback seen for ${tranId} — will verify via status check.`);
    }
  }
  // ឆ្លើយ 200 ភ្លាមៗជានិច្ច (PayWay មិនត្រូវការ body ពិសេសទេ)
  res.status(200).json({ ok: true });
});

// ---------- Licenses (v1.1.3 — SR Downloader: 1 Key = 1 PC AT A TIME, or a public weekly key) ----------
// POST /api/license/create — admin only (X-Admin-Secret).
//   Body: { buyer (required), telegram?, expiresAt? (ISO or DD/MM/YYYY),
//           expiresInDays?, maxDevices? (1–10, default 1),
//           activationDays? (1–365) } → { ok, key, expiresAt, maxDevices, activationDays }
//   activationDays = PUBLIC WEEKLY KEY: the key has NO fixed expiry
//   (expiresAt null, activationBased true); each device that activates
//   gets its own expiresAt = activation time + activationDays.
//   When activationDays is given, expiresAt/expiresInDays are ignored.
//   A Sheets failure is logged and NEVER fails the create.
app.post('/api/license/create', async (req, res) => {
  if (!requireLicenseAdmin(req, res)) return;
  const body = req.body || {};
  const buyer = typeof body.buyer === 'string' ? body.buyer.trim() : '';
  if (!buyer) return res.status(400).json({ ok: false, error: 'buyer is required' });
  const telegram = typeof body.telegram === 'string' ? body.telegram.trim() : '';
  // maxDevices: 1–10 (default 1 = legacy 1-PC key).
  let maxDevices = 1;
  if (body.maxDevices !== undefined && body.maxDevices !== null && body.maxDevices !== '') {
    maxDevices = Number(body.maxDevices);
    if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 10) {
      return res.status(400).json({ ok: false, error: 'maxDevices must be an integer from 1 to 10' });
    }
  }
  // activationDays: 1–365 (optional). Present = activation-based key.
  let activationDays = null;
  if (body.activationDays !== undefined && body.activationDays !== null && body.activationDays !== '') {
    activationDays = Number(body.activationDays);
    if (!Number.isInteger(activationDays) || activationDays < 1 || activationDays > 365) {
      return res.status(400).json({ ok: false, error: 'activationDays must be an integer from 1 to 365' });
    }
  }
  const activationBased = activationDays !== null;
  const parsed = activationBased ? { expiresAt: null } : parseLicenseExpiry(body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

  const licenses = loadLicenses();
  let displayKey = generateLicenseKey();
  let key = normalizeKey(displayKey);
  while (licenses[key]) { displayKey = generateLicenseKey(); key = normalizeKey(displayKey); } // avoid collision
  const lic = {
    key, // normalized (canonical) — licenses.json is keyed by this
    displayKey, // dashed, human-readable (shown to buyer + in Sheet)
    buyer,
    telegram,
    createdAt: new Date().toISOString(),
    expiresAt: parsed.expiresAt,
    machineId: null,
    boundAt: null,
    previousMachineId: null, // last PC before the latest re-bind
    blockedMachineIds: [], // PCs the key moved AWAY from — blocked until admin unbind
    rebindCount: 0, // how many times the key moved to a new PC (online)
    rebindHistory: [], // [{ machineId, at }] — last 10 moves
    status: 'active',
    lastVerifiedAt: null,
    maxDevices, // v1.1.3 — how many devices may activate this key
    activationDays, // v1.1.3 — null = legacy fixed-expiry key
    activationBased, // v1.1.3 — true = per-device expiry from activation
    activations: [] // v1.1.3 — [{ machineId, activatedAt, expiresAt }]
  };
  licenses[key] = lic;
  saveLicenses(licenses);
  await sheetsAppendLicense(lic); // never throws (errors caught + logged)
  res.json({ ok: true, key: displayKey, expiresAt: lic.expiresAt, maxDevices: lic.maxDevices, activationDays: lic.activationDays });
});

// POST /api/license/verify — public (called by the PC app on launch).
//   Body: { key, machineId } → { valid, expiresAt, buyer, rebound }
//   or { valid:false, error } with error one of:
//   unknown_key | revoked | expired | moved_to_another_pc | device_limit
//   LEGACY keys (v1.1.2): first verify binds the key to that machineId.
//   A later verify from a DIFFERENT machineId RE-BINDS the key to the
//   new PC (v1.1.1: keys float, 1 PC at a time, move requires internet)
//   — and the PC it moved AWAY from is BLOCKED for that key (v1.1.2).
//   A blocked PC that verifies gets { valid:false,
//   error:'moved_to_another_pc' } and can never use the key again until
//   an admin unbinds it (unbind clears the block). The block only bites
//   when the old PC goes ONLINE; while offline it keeps working until
//   its 7-day grace ends. Expired/revoked keys never re-bind.
//   `rebound` is true only on a move.
//   ACTIVATION-BASED keys (v1.1.3, public weekly keys): the legacy flow
//   does NOT apply. The device is looked up in activations[]: found and
//   unexpired → valid with THAT device's expiresAt; found and expired →
//   expired; not found and slots remain (activations.length < maxDevices)
//   → a new activation is created (now + activationDays) and returned;
//   not found and full → { valid:false, error:'device_limit' }.
//   expiresAt in the reply is always the CALLING device's own expiry,
//   which is exactly what the app stores and counts down from.
app.post('/api/license/verify', async (req, res) => {
  const body = req.body || {};
  const key = normalizeKey(typeof body.key === 'string' ? body.key.trim() : '');
  const machineId = typeof body.machineId === 'string' ? body.machineId.trim() : '';
  if (!key || !machineId) return res.status(400).json({ valid: false, error: 'key and machineId are required' });

  const licenses = loadLicenses();
  const lic = licenses[key];
  if (!lic) return res.json({ valid: false, error: 'unknown_key' });
  if (lic.status !== 'active') return res.json({ valid: false, error: 'revoked' });

  // v1.1.3 — ACTIVATION-BASED KEY (public weekly key). The legacy
  // single-machine flow below does NOT apply to these keys.
  if (lic.activationBased) {
    const now = new Date();
    const act = findActivation(lic, machineId);
    if (act) {
      if (now.getTime() > new Date(act.expiresAt).getTime()) {
        return res.json({ valid: false, error: 'expired' });
      }
      lic.lastVerifiedAt = now.toISOString();
      saveLicenses(licenses);
      return res.json({ valid: true, expiresAt: act.expiresAt, buyer: lic.buyer, rebound: false });
    }
    const used = Array.isArray(lic.activations) ? lic.activations.length : 0;
    if (used >= licenseMaxDevices(lic)) {
      return res.json({ valid: false, error: 'device_limit' });
    }
    const newAct = activateDevice(lic, machineId, now);
    lic.lastVerifiedAt = now.toISOString();
    saveLicenses(licenses);
    await sheetsUpdateBind(lic); // never throws — logs the device list
    return res.json({ valid: true, expiresAt: newAct.expiresAt, buyer: lic.buyer, rebound: false });
  }

  if (isLicenseExpired(lic)) return res.json({ valid: false, error: 'expired' });
  if (Array.isArray(lic.blockedMachineIds) && lic.blockedMachineIds.includes(machineId)) {
    return res.json({ valid: false, error: 'moved_to_another_pc' });
  }

  const firstBind = !lic.machineId;
  const rebound = !firstBind && lic.machineId !== machineId;
  if (rebound) {
    lic.previousMachineId = lic.machineId;
    lic.blockedMachineIds = Array.isArray(lic.blockedMachineIds) ? lic.blockedMachineIds : [];
    if (!lic.blockedMachineIds.includes(lic.previousMachineId)) lic.blockedMachineIds.push(lic.previousMachineId);
    lic.machineId = machineId;
    lic.boundAt = new Date().toISOString();
    lic.rebindCount = (lic.rebindCount || 0) + 1;
    lic.rebindHistory = Array.isArray(lic.rebindHistory) ? lic.rebindHistory : [];
    lic.rebindHistory.push({ machineId, at: lic.boundAt });
    if (lic.rebindHistory.length > 10) lic.rebindHistory = lic.rebindHistory.slice(-10);
  } else if (firstBind) {
    lic.machineId = machineId;
    lic.boundAt = new Date().toISOString();
  }
  lic.lastVerifiedAt = new Date().toISOString();
  saveLicenses(licenses);
  if (firstBind || rebound) await sheetsUpdateBind(lic); // never throws
  res.json({ valid: true, expiresAt: lic.expiresAt, buyer: lic.buyer, rebound });
});

// POST /api/license/unbind — admin only (X-Admin-Secret).
//   Body: { key } → frees the key for another PC (also clears the
//   blocked-PC list, so a previously moved-away PC may use it again).
//   For an activation-based key (v1.1.3) it clears ALL device
//   activations, freeing every slot (devices must re-activate).
app.post('/api/license/unbind', (req, res) => {
  if (!requireLicenseAdmin(req, res)) return;
  const key = normalizeKey(req.body && typeof req.body.key === 'string' ? req.body.key.trim() : '');
  if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
  const licenses = loadLicenses();
  const lic = licenses[key];
  if (!lic) return res.status(404).json({ ok: false, error: 'unknown key' });
  lic.machineId = null;
  lic.boundAt = null;
  lic.blockedMachineIds = [];
  lic.previousMachineId = null;
  if (lic.activationBased) lic.activations = []; // free all device slots
  saveLicenses(licenses);
  res.json({ ok: true });
});

// GET /api/license/list — admin only (X-Admin-Secret).
//   Each record carries maxDevices (legacy records default to 1) and
//   activationCount (legacy records: 0).
app.get('/api/license/list', (req, res) => {
  if (!requireLicenseAdmin(req, res)) return;
  const licenses = loadLicenses();
  const keys = Object.values(licenses).map((lic) => ({
    ...lic,
    maxDevices: licenseMaxDevices(lic),
    activationCount: Array.isArray(lic.activations) ? lic.activations.length : 0
  }));
  res.json({ ok: true, keys });
});

// ---------- 404 + error handler ----------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not found' });
});
app.use((err, req, res, next) => {
  console.error('[PayServer] Unhandled error:', err && err.message);
  res.status(500).json({ ok: false, error: 'Server error / មានបញ្ហា server សូមសាកម្តងទៀត' });
});

// ---------- start (only when run directly) ----------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[PayServer] Listening on port ${PORT}. PayWay: ${payway ? 'configured' : 'MISSING CREDENTIALS'}`);
  });
}

module.exports = { app, creditTopup, loadWallets, loadTopups, makeTranId, ALLOWED_AMOUNTS, extractPaywayQr, paywayReqTime, generateQrHash, buildGenerateQrBody, createQrViaGenerateQr, createQrViaPurchase, extractUrlsFromHtml, generateLicenseKey, normalizeKey, parseLicenseExpiry, loadLicenses, saveLicenses, isLicenseExpired, findActivation, activateDevice, licenseMaxDevices, __setSheetsClient, SHEET_HEADERS };
