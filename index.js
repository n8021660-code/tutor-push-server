'use strict';

const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');

// -------------------------
// Helpers
// -------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseCsvEnv(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function decodeServiceAccountFromB64(b64) {
  const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  const obj = safeJsonParse(jsonStr);
  if (!obj) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64 JSON');
  return obj;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// принимаем +7912... или 7912..., нормализуем в "7912..."
function normalizePhoneDigits(phone) {
  let p = String(phone || '').trim();
  p = p.replace(/\s+/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  p = p.replace(/[^\d]/g, '');
  if (p.length < 10) return null;
  return p;
}

function toE164(digits) {
  // простой вариант: если начинается с 7 — РФ
  if (digits.startsWith('7')) return `+${digits}`;
  return `+${digits}`;
}

// -------------------------
// Firebase Admin init
// -------------------------
const serviceAccountB64 = requireEnv('FIREBASE_SERVICE_ACCOUNT_B64');
const serviceAccount = decodeServiceAccountFromB64(serviceAccountB64);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const PROJECT_ID = serviceAccount.project_id || '(unknown)';

// -------------------------
// Express
// -------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

const ADMIN_UIDS = parseCsvEnv('ADMIN_UIDS');
const PUSH_API_KEY = (process.env.PUSH_API_KEY || '').trim();

function checkApiKey(req) {
  if (!PUSH_API_KEY) return true; // dev mode
  const headerKey = (req.headers['x-api-key'] || '').toString().trim();
  return headerKey === PUSH_API_KEY;
}

function isAdminUid(uid) {
  return uid && ADMIN_UIDS.includes(uid);
}

// Bearer ID token → admin check
async function requireAdminBearer(req, res, next) {
  try {
    const auth = (req.headers.authorization || '').toString();
    const m = auth.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ ok: false, error: 'missing_bearer' });

    const idToken = m[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    if (!isAdminUid(uid)) {
      return res.status(403).json({ ok: false, error: 'not_admin', uid });
    }

    req.adminUid = uid;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'bad_token', detail: String(e.message || e) });
  }
}

// -------------------------
// Core: get tokens for users
// -------------------------
async function getTokensForUsers(userIds) {
  const tokens = [];

  for (const uid of userIds) {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) continue;

    const data = doc.data() || {};
    const fcmTokens = data.fcmTokens || {};

    for (const [token, val] of Object.entries(fcmTokens)) {
      if (!token || token.length < 10) continue;
      if (val === true || val === 'true' || val === 1 || val === '1') tokens.push(token);
      else if (val && typeof val === 'object') tokens.push(token);
    }
  }

  return Array.from(new Set(tokens));
}

async function sendPushToUsers(userIds, title, body, data) {
  const tokens = await getTokensForUsers(userIds);

  if (!tokens.length) {
    return { ok: false, error: 'no_tokens', tokens: 0 };
  }

  const message = {
    tokens,
    notification: { title: String(title || ''), body: String(body || '') },
    data: data && typeof data === 'object'
      ? Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k), String(v)]))
      : undefined,
    android: { priority: 'high' },
  };

  const resp = await admin.messaging().sendEachForMulticast(message);

  const invalidTokens = [];
  resp.responses.forEach((r, idx) => {
    if (!r.success) {
      const code = r.error?.code || '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) invalidTokens.push(tokens[idx]);
    }
  });

  return {
    ok: true,
    requested: tokens.length,
    successCount: resp.successCount,
    failureCount: resp.failureCount,
    invalidTokens,
  };
}

// -------------------------
// Registration by invite (phone + 6 code)
// -------------------------
// Firestore:
// invites/{phoneDigits}
//   { role, phone, codeHash, expiresAt, used, createdAt, createdBy }

const INVITES_COL = 'invites';
const USERS_COL = 'users';

// Admin creates invite
app.post('/admin/invite', requireAdminBearer, async (req, res) => {
  try {
    const { phone, role, code, ttlMinutes } = req.body || {};

    const phoneDigits = normalizePhoneDigits(phone);
    if (!phoneDigits) return res.status(400).json({ ok: false, error: 'bad_phone' });

    const allowedRoles = ['tutor', 'student', 'parent'];
    if (!allowedRoles.includes(String(role))) return res.status(400).json({ ok: false, error: 'bad_role' });

    const codeStr = String(code || '').trim();
    if (!/^\d{6}$/.test(codeStr)) return res.status(400).json({ ok: false, error: 'bad_code_6_digits' });

    const ttl = Number.isFinite(+ttlMinutes)
      ? Math.max(1, Math.min(60 * 24 * 7, +ttlMinutes))
      : 60 * 24; // default 24h

    const expiresAt = Date.now() + ttl * 60 * 1000;

    const ref = db.collection(INVITES_COL).doc(phoneDigits);
    await ref.set({
      role: String(role),
      phone: toE164(phoneDigits),
      codeHash: sha256(codeStr),
      expiresAt,
      used: false,
      createdAt: Date.now(),
      createdBy: req.adminUid,
    }, { merge: true });

    return res.json({ ok: true, phoneDigits, phone: toE164(phoneDigits), role: String(role), expiresAt });
  } catch (e) {
    console.error('POST /admin/invite error:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// User logs in by phone+code -> gets customToken
app.post('/auth/login', async (req, res) => {
  try {
    const { phone, code } = req.body || {};

    const phoneDigits = normalizePhoneDigits(phone);
    if (!phoneDigits) return res.status(400).json({ ok: false, error: 'bad_phone' });

    const codeStr = String(code || '').trim();
    if (!/^\d{6}$/.test(codeStr)) return res.status(400).json({ ok: false, error: 'bad_code' });

    const inviteRef = db.collection(INVITES_COL).doc(phoneDigits);
    const snap = await inviteRef.get();

    if (!snap.exists) return res.status(404).json({ ok: false, error: 'invite_not_found' });

    const inv = snap.data() || {};
    if (inv.used === true) return res.status(403).json({ ok: false, error: 'invite_used' });
    if (typeof inv.expiresAt === 'number' && Date.now() > inv.expiresAt) {
      return res.status(403).json({ ok: false, error: 'invite_expired' });
    }

    if (inv.codeHash !== sha256(codeStr)) return res.status(403).json({ ok: false, error: 'wrong_code' });

    const role = String(inv.role || 'student');
    const phoneE164 = String(inv.phone || toE164(phoneDigits));

    // стабильный uid по номеру
    const uid = `p_${phoneDigits}`;

    // создаём/обновляем Auth user
    try {
      await admin.auth().getUser(uid);
    } catch (_) {
      await admin.auth().createUser({ uid });
    }

    // профиль
    await db.collection(USERS_COL).doc(uid).set({
      phone: phoneE164,
      role,
      lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // пометить инвайт использованным (одноразовый)
    await inviteRef.set({
      used: true,
      usedAt: Date.now(),
      usedByUid: uid,
    }, { merge: true });

    // custom token
    const customToken = await admin.auth().createCustomToken(uid, { role });

    return res.json({ ok: true, uid, role, phone: phoneE164, customToken });
  } catch (e) {
    console.error('POST /auth/login error:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// -------------------------
// Routes
// -------------------------
app.get('/', (req, res) => {
  res.type('text/plain').send(`Tutor Push Server v5 (project_id=${PROJECT_ID})`);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, project_id: PROJECT_ID, admin_uids: ADMIN_UIDS.length });
});

// Send push by API key
app.post('/send', async (req, res) => {
  try {
    if (!checkApiKey(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const { toUserIds, title, body, data } = req.body || {};
    if (!Array.isArray(toUserIds) || toUserIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'toUserIds_required' });
    }

    const result = await sendPushToUsers(toUserIds, title, body, data);
    return res.json(result);
  } catch (e) {
    console.error('POST /send error:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Debug: check user + tokens
app.get('/debug/user/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) {
      return res.json({ ok: true, exists: false, uid, project_id: PROJECT_ID });
    }
    const data = doc.data() || {};
    const fcmTokens = data.fcmTokens || {};
    const keys = Object.keys(fcmTokens);

    return res.json({
      ok: true,
      exists: true,
      uid,
      project_id: PROJECT_ID,
      fcmTokensKeysCount: keys.length,
      fcmTokensKeysFirst10: keys.slice(0, 10),
      fcmTokensSample: keys.slice(0, 3).map(k => [k, typeof fcmTokens[k], fcmTokens[k]]),
    });
  } catch (e) {
    console.error('GET /debug/user/:uid error:', e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// -------------------------
// Firestore listener: notifications (sent==false)
// -------------------------
function startNotificationsListener() {
  console.log('👂 Listening for notifications...');
  db.collection('notifications')
    .where('sent', '==', false)
    .onSnapshot(async (snap) => {
      if (snap.empty) return;

      for (const doc of snap.docs) {
        const notif = doc.data() || {};
        const toUserIds = Array.isArray(notif.toUserIds) ? notif.toUserIds : [];
        const title = notif.title || 'Уведомление';
        const body = notif.body || '';
        const data = notif.data && typeof notif.data === 'object' ? notif.data : undefined;

        console.log(`📨 notification doc=${doc.id} to=${toUserIds.length}`);

        try {
          const result = await sendPushToUsers(toUserIds, title, body, data);
          await doc.ref.set({
            sent: true,
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
            result,
          }, { merge: true });
          console.log(`✅ processed doc=${doc.id}`, result);
        } catch (e) {
          console.error(`❌ failed doc=${doc.id}`, e);
          await doc.ref.set({
            error: String(e.message || e),
            lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }
    }, (err) => console.error('🔥 listener error', err));
}

// -------------------------
// Start server
// -------------------------
const PORT = parseInt(process.env.PORT || '10000', 10);
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`project_id=${PROJECT_ID}`);
  console.log(`ADMIN_UIDS=${ADMIN_UIDS.join(',') || '(none)'}`);
  startNotificationsListener();
});