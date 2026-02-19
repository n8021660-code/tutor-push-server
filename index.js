const admin = require("firebase-admin");
const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

function loadServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64;
  if (b64 && b64.trim().length > 0) {
    const jsonText = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(jsonText);
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim().length > 0) return JSON.parse(raw);
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON_B64 or FIREBASE_SERVICE_ACCOUNT_JSON");
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
});

const db = admin.firestore();

function chunk(arr, size) {
  const res = [];
  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
  return res;
}

app.get("/", (req, res) => res.send("Tutor Push Server running"));

async function sendToUserIds({ toUserIds, title, body, data }) {
  const userRefs = toUserIds.map((uid) => db.collection("users").doc(uid));
  const userSnaps = await db.getAll(...userRefs);

  let tokens = [];
  for (const us of userSnaps) {
    if (!us.exists) continue;
    const ud = us.data() || {};
    const fcmTokens = ud.fcmTokens || {};
    tokens.push(...Object.keys(fcmTokens));
  }
  tokens = [...new Set(tokens)].filter(Boolean);

  if (tokens.length === 0) {
    return { ok: false, error: "no_tokens", tokens: 0 };
  }

  const payload = {
    notification: { title: String(title || "Уведомление"), body: String(body || "") },
    data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [String(k), String(v)])),
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

// ✅ РУЧНОЙ ТЕСТ: отправка пуша по HTTP
// POST /send { toUserIds: ["UID"], title: "...", body: "...", data: {...} }
app.post("/send", async (req, res) => {
  try {
    const toUserIds = Array.isArray(req.body?.toUserIds) ? req.body.toUserIds : [];
    const title = req.body?.title || "Тест";
    const body = req.body?.body || "Проверка";
    const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : {};

    if (toUserIds.length === 0) return res.status(400).json({ ok: false, error: "no_toUserIds" });

    const result = await sendToUserIds({ toUserIds, title, body, data });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log("Server started on port", PORT));

        await doc.ref.update({
          sent: true,
          error: null,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log("Push sent:", doc.id, "tokens:", tokens.length);
      } catch (e) {
        console.error("Push error:", e);
        await doc.ref.update({
          sent: false,
          error: String(e),
        });
      }
    }
  });

app.listen(PORT, () => console.log("Server started on port", PORT));
