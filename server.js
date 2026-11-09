// ============================================================
// PayServer v1.0.0 — ABA PayWay KHQR auto top-up server
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
const TOPUP_QR_EXPIRES_IN = 180;        // 180 វិនាទី — បង្ហាញក្នុង Mini App
const ALLOWED_AMOUNTS = [1, 2, 5, 10, 20, 50, 100];

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
function makeTranId(telegramId) {
  const rand = Math.random().toString(36).slice(2, 6); // 4 តួអក្សរ
  return `D${String(telegramId)}-${Date.now().toString(36)}${rand}`;
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
  try {
    const payload = payway.buildTransactionPayload({
      tran_id: tranId,
      payment_option: 'abapay_khqr',
      amount: amount,
      currency: 'USD',
      lifetime: 10, // 10 នាទី (PayWay lifetime unit = minutes) — ត្រូវគ្នានឹង server expiry
      ...(PUBLIC_URL ? { return_url: PUBLIC_URL + '/api/payway/callback' } : {})
    });
    const result = await payway.execute(payload);

    // PayWay ប្រាប់ success តែពេល status.code === '00' និងមាន qr_string
    if (!result || !result.status || result.status.code !== '00' || !result.qr_string) {
      const msg = (result && result.status && result.status.message)
        ? String(result.status.message)
        : 'PayWay did not return a QR';
      console.warn(`[PayServer] PayWay create failed for ${tranId}: ${msg}`);
      return res.status(502).json({ ok: false, error: `PayWay: ${msg} / PayWay មិនបានបង្កើត QR` });
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

    // QR string → PNG data URL (សម្រាប់បង្ហាញក្នុង Mini App)
    const qrImage = await QRCode.toDataURL(result.qr_string, { margin: 1, width: 400 });

    return res.json({
      ok: true,
      tran_id: tranId,
      qr_image: qrImage,
      abapay_deeplink: result.abapay_deeplink || null,
      checkout_qr_url: result.checkout_qr_url || null,
      amount: amount,
      expires_in: TOPUP_QR_EXPIRES_IN
    });
  } catch (err) {
    const msg = paywayErrorMessage(err);
    console.warn(`[PayServer] PayWay create error for ${tranId}: ${msg}`);
    return res.status(502).json({ ok: false, error: `PayWay: ${msg} / បង្កើតការបង់ប្រាក់មិនបាន សូមសាកម្តងទៀត` });
  }
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

module.exports = { app, creditTopup, loadWallets, loadTopups, makeTranId, ALLOWED_AMOUNTS };
