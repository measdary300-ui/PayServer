// ============================================================
// PayServer v1.0.4 — ABA PayWay KHQR auto top-up server
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

// ---------- app ----------
const app = express();
app.use(cors()); // v1: allow all origins (Mini App នៅលើ GitHub Pages)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---------- GET /health ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, payway: payway ? 'configured' : 'missing', time: new Date().toISOString() });
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

module.exports = { app, creditTopup, loadWallets, loadTopups, makeTranId, ALLOWED_AMOUNTS, extractPaywayQr, paywayReqTime, generateQrHash, buildGenerateQrBody, createQrViaGenerateQr, createQrViaPurchase, extractUrlsFromHtml };
