const admin = require("firebase-admin");
const express = require("express");

const app = express();
app.use(express.json());
// ================= PUSH LISTENER =================

async function sendPushToUsers(userIds, title, body) {
  let tokens = [];

  for (const uid of userIds) {
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) continue;

    const data = doc.data() || {};
    const fcmTokens = data.fcmTokens || {};
    tokens.push(...Object.keys(fcmTokens));
  }

  if (tokens.length === 0) {
    console.log('❌ No tokens found');
    return { success: 0 };
  }

  const message = {
    notification: { title, body },
    tokens,
  };

  const response = await admin.messaging().sendEachForMulticast(message);

  console.log('✅ Push sent:', response.successCount, '/', tokens.length);

  return { success: response.successCount };
}
  const usersSnap = await db.collection('users')
    .where(admin.firestore.FieldPath.documentId(), 'in', userIds)
    .get();

  let tokens = [];

  usersSnap.forEach(doc => {
    const data = doc.data() || {};
    const fcmTokens = data.fcmTokens || {};
    tokens.push(...Object.keys(fcmTokens));
  });

  if (tokens.length === 0) {
    console.log('❌ No tokens found');
    return { success: 0 };
  }

  const message = {
    notification: { title, body },
    tokens,
  };

  const response = await admin.messaging().sendEachForMulticast(message);

  console.log('✅ Push sent:', response.successCount, '/', tokens.length);

  return { success: response.successCount };
}

db.collection('notifications')
  .where('sent', '==', false)
  .onSnapshot(async snapshot => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;

      const doc = change.doc;
      const data = doc.data();

      console.log('📨 New notification:', doc.id);

      try {
        const result = await sendPushToUsers(
          data.toUserIds || [],
          data.title || '',
          data.body || ''
        );

        await doc.ref.update({
          sent: true,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          success: result.success
        });

      } catch (err) {
        console.error('🔥 Push error:', err);
      }
    }
  });

console.log('👂 Listening for notifications...');
const PORT = process.env.PORT || 10000;

// 🔐 Простой ключ доступа для /send (задашь в Render Env)
const API_KEY = (process.env.PUSH_API_KEY || "").trim();

function loadServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64;
  if (b64 && b64.trim().length > 0) {
    const jsonText = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(jsonText);
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim().length > 0) return JSON.parse(raw);

  throw new Error(
    "Missing FIREBASE_SERVICE_ACCOUNT_JSON_B64 or FIREBASE_SERVICE_ACCOUNT_JSON"
  );
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

app.get("/", (req, res) => {
  res.send(`Tutor Push Server v5 (project_id=${serviceAccount.project_id})`);
});

// ✅ Диагностика: список users
app.get("/debug/users", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "5", 10) || 5, 20);
    const qs = await db.collection("users").limit(limit).get();

    res.json({
      ok: true,
      project_id: serviceAccount.project_id,
      count: qs.size,
      ids: qs.docs.map((d) => d.id),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ✅ Диагностика: один user
app.get("/debug/user/:uid", async (req, res) => {
  try {
    const uid = req.params.uid;
    const snap = await db.collection("users").doc(uid).get();

    if (!snap.exists) {
      return res.json({
        ok: true,
        exists: false,
        uid,
        project_id: serviceAccount.project_id,
      });
    }

    const data = snap.data() || {};
    const fcmTokens =
      data.fcmTokens && typeof data.fcmTokens === "object" ? data.fcmTokens : {};
    const tokenKeys = Object.keys(fcmTokens);

    res.json({
      ok: true,
      exists: true,
      uid,
      project_id: serviceAccount.project_id,
      fcmTokensKeysCount: tokenKeys.length,
      fcmTokensKeysFirst10: tokenKeys.slice(0, 10),
      fcmTokensSample: tokenKeys
        .slice(0, 3)
        .map((k) => [k, typeof fcmTokens[k], fcmTokens[k]]),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

async function sendToUserIds({ toUserIds, title, body, data }) {
  const userRefs = toUserIds.map((uid) => db.collection("users").doc(uid));
  const userSnaps = await db.getAll(...userRefs);

  let tokens = [];
  for (const us of userSnaps) {
    if (!us.exists) continue;
    const ud = us.data() || {};
    const fcmTokens =
      ud.fcmTokens && typeof ud.fcmTokens === "object" ? ud.fcmTokens : {};
    tokens.push(...Object.keys(fcmTokens));
  }

  tokens = [...new Set(tokens)].filter(Boolean);

  if (tokens.length === 0) {
    return { ok: false, error: "no_tokens", tokens: 0 };
  }

  const payload = {
    notification: {
      title: String(title || "Уведомление"),
      body: String(body || ""),
    },
    data: Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [String(k), String(v)])
    ),
  };

  const batches = chunk(tokens, 500);
  let success = 0;
  let failure = 0;

  for (const tks of batches) {
    const r = await admin.messaging().sendEachForMulticast({
      tokens: tks,
      ...payload,
    });
    success += r.successCount;
    failure += r.failureCount;
  }

  return { ok: true, tokens: tokens.length, success, failure };
}

// 🔐 middleware: проверка ключа
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // если ключ не задан — не блокируем (на время теста)
  const got = (req.header("x-api-key") || "").trim();
  if (!got || got !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ✅ Основной endpoint: Flutter будет дёргать его при действиях
// POST /send  body: { toUserIds: ["uid"], title, body, data }
app.post("/send", requireApiKey, async (req, res) => {
  try {
    const toUserIds = Array.isArray(req.body?.toUserIds)
      ? req.body.toUserIds
      : [];
    const title = req.body?.title || "Уведомление";
    const body = req.body?.body || "";
    const data =
      req.body?.data && typeof req.body.data === "object" ? req.body.data : {};

    if (toUserIds.length === 0) {
      return res.status(400).json({ ok: false, error: "no_toUserIds" });
    }

    const result = await sendToUserIds({ toUserIds, title, body, data });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log("Server started on port", PORT));
