// index.js
'use strict';

const express = require('express');
const admin = require('firebase-admin');

// -------------------------
// Helpers
// -------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

function parseAdminUids() {
  const raw = (process.env.ADMIN_UIDS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

function decodeServiceAccountFromB64(b64) {
  const jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  const obj = safeJsonParse(jsonStr);
  if (!obj) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 is not valid base64 JSON');
  return obj;
}

function isTruthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
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
// Express app
// -------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

const ADMIN_UIDS = parseAdminUids();
const PUSH_API_KEY = (process.env.PUSH_API_KEY || '').trim();

// Optional very simple protection by API key for /send
function checkApiKey(req) {
  if (!PUSH_API_KEY) return true; // if not set, allow (dev mode)
  const headerKey = (req.headers['x-api-key'] || req.headers['X-API-KEY'] || '').toString().trim();
  return headerKey === PUSH_API_KEY;
}

function isAdminUid(uid) {
  if (!uid) return false;
  return ADMIN_UIDS.includes(uid);
}

// -------------------------
// Core: get FCM tokens for uids
// -------------------------
async function getTokensForUsers(userIds) {
  const tokens = [];

  for (const uid of userIds) {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) continue;

    const data = doc.data() || {};
    const fcmTokens = data.fcmTokens || {};

    // support map: { token: true }
    // also accept { token: {active:true} } or { token: 1 } etc.
    for (const [token, val] of Object.entries(fcmTokens)) {
      if (!token || token.length < 10) continue;
      if (val && typeof val === 'object') {
        // if stored as object, accept active flag or any object as valid
        if ('active' in val) {
          if (isTruthy(val.active)) tokens.push(token);
        } else {
          tokens.push(token);
        }
      } else {
        if (isTruthy(val)) tokens.push(token);
      }
    }
  }

  // unique
  return Array.from(new Set(tokens));
}

// -------------------------
// Core: send push
// -------------------------
async function sendPushToUsers(userIds, title, body, data) {
  const tokens = await getTokensForUsers(userIds);

  if (!tokens.length) {
    return { ok: false, error: 'no_tokens', tokens: 0 };
  }

  const message = {
    tokens,
    notification: {
      title: String(title || ''),
      body: String(body || ''),
    },
    data: data && typeof data === 'object' ? Object.fromEntries(
      Object.entries(data).map(([k, v]) => [String(k), String(v)])
    ) : undefined,
    android: {
      priority: 'high',
    },
  };

  const resp = await admin.messaging().sendEachForMulticast(message);

  // remove invalid tokens (optional cleanup)
  const invalidTokens = [];
  resp.responses.forEach((r, idx) => {
    if (!r.success) {
      const code = r.error?.code || '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        invalidTokens.push(tokens[idx]);
      }
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
// Routes
// -------------------------
app.get('/', (req, res) => {
  res.type('text/plain').send(`Tutor Push Server running v3 (project_id=${PROJECT_ID})`);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, project_id: PROJECT_ID, admin_uids: ADMIN_UIDS.length });
});

// POST /send
// Body: { toUserIds: ["uid1"], title:"...", body:"...", data:{...} }
app.post('/send', async (req, res) => {
  try {
    if (!checkApiKey(req)) {
      return res.status(401).json({ ok: false, error: 'bad_api_key' });
    }

    const { toUserIds, title, body, data } = req.body || {};
    if (!Array.isArray(toUserIds) || toUserIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'toUserIds_required' });
    }

    const result = await sendPushToUsers(toUserIds, title, body, data);
    res.json(result);
  } catch (e) {
    console.error('POST /send error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Debug: check if user doc exists + count tokens
app.get('/debug/user/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    const doc = await db.collection('users').doc(uid).get();
    const exists = doc.exists;
    const data = doc.data() || {};
    const fcmTokens = data.fcmTokens || {};
    const tokenCount = Object.keys(fcmTokens).length;

    res.json({
      ok: true,
      uid,
      exists,
      project_id: PROJECT_ID,
      tokenCount,
      tokenKeysPreview: Object.keys(fcmTokens).slice(0, 3),
      updatedAt: data.updatedAt || null,
    });
  } catch (e) {
    console.error('GET /debug/user/:uid error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Debug: list users (requires admin via query ?adminUid=UID)
app.get('/debug/users', async (req, res) => {
  try {
    const adminUid = (req.query.adminUid || '').toString().trim();
    if (!isAdminUid(adminUid)) {
      return res.status(403).json({ ok: false, error: 'admin_only' });
    }

    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || '10', 10) || 10));
    const snap = await db.collection('users').orderBy('updatedAt', 'desc').limit(limit).get();

    const items = snap.docs.map((d) => {
      const data = d.data() || {};
      const fcmTokens = data.fcmTokens || {};
      return {
        uid: d.id,
        tokenCount: Object.keys(fcmTokens).length,
        updatedAt: data.updatedAt || null,
      };
    });

    res.json({ ok: true, project_id: PROJECT_ID, count: items.length, items });
  } catch (e) {
    console.error('GET /debug/users error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// -------------------------
// Firestore listener: notifications
// -------------------------
function startNotificationsListener() {
  console.log('👂 Listening for notifications...');

  db.collection('notifications')
    .where('sent', '==', false)
    .onSnapshot(
      async (snap) => {
        if (snap.empty) return;

        for (const doc of snap.docs) {
          const notif = doc.data() || {};

          // Expected schema:
          // toUserIds: array<string>
          // title: string
          // body: string
          // sent: false
          const toUserIds = Array.isArray(notif.toUserIds) ? notif.toUserIds : Array.isArray(notif.toUserIds) ? notif.toUserIds : [];
          const title = notif.title || 'Уведомление';
          const body = notif.body || '';
          const data = notif.data && typeof notif.data === 'object' ? notif.data : undefined;

          console.log(`📨 New notification doc=${doc.id} toUserIds=${(toUserIds || []).length}`);

          try {
            // normalize: if user mistakenly created field "toUserIds" but named "toUserIds" ok.
            // if someone uses "toUserIds" vs "toUserIds" etc — we only support toUserIds.
            const ids = Array.isArray(notif.toUserIds) ? notif.toUserIds : [];
            const result = await sendPushToUsers(ids, title, body, data);

            await doc.ref.set(
              {
                sent: true,
                sentAt: admin.firestore.FieldValue.serverTimestamp(),
                result,
              },
              { merge: true }
            );

            console.log(`✅ Processed doc=${doc.id}`, result);
          } catch (e) {
            console.error(`❌ Failed doc=${doc.id}:`, e);
            await doc.ref.set(
              {
                error: String(e.message || e),
                lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }
        }
      },
      (err) => {
        console.error('🔥 Listener error:', err);
      }
    );
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