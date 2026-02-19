const admin = require("firebase-admin");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Мы поддерживаем 2 режима:
 * 1) FIREBASE_SERVICE_ACCOUNT_JSON_B64 (рекомендовано) — base64 от JSON
 * 2) FIREBASE_SERVICE_ACCOUNT_JSON — сырой JSON (если удастся вставить без поломки)
 */
function loadServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64;
  if (b64 && b64.trim().length > 0) {
    const jsonText = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(jsonText);
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && raw.trim().length > 0) {
    return JSON.parse(raw);
  }

  throw new Error(
    "Missing FIREBASE_SERVICE_ACCOUNT_JSON_B64 or FIREBASE_SERVICE_ACCOUNT_JSON env var"
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

// healthcheck, чтобы Render и UptimeRobot могли “пинать”
app.get("/", (req, res) => {
  res.send("Tutor Push Server running");
});

// Слушаем уведомления и отправляем пуши
db.collection("notifications")
  .where("sent", "==", false)
  .onSnapshot(async (snapshot) => {
    for (const doc of snapshot.docs) {
      const notif = doc.data() || {};
      const toUserIds = Array.isArray(notif.toUserIds) ? notif.toUserIds : [];
      const title = (notif.title || "Уведомление").toString();
      const body = (notif.body || "").toString();
      const data =
        notif.data && typeof notif.data === "object" ? notif.data : {};

      if (toUserIds.length === 0) {
        await doc.ref.update({
          sent: true,
          error: "no_toUserIds",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        continue;
      }

      try {
        // Собираем токены пользователей
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
          await doc.ref.update({
            sent: true,
            error: "no_tokens",
            sentAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          continue;
        }

        // FCM ограничение: батчи до 500 токенов
        const batches = chunk(tokens, 500);
        for (const tks of batches) {
          await admin.messaging().sendEachForMulticast({
            tokens: tks,
            notification: { title, body },
            data: Object.fromEntries(
              Object.entries(data).map(([k, v]) => [String(k), String(v)])
            ),
          });
        }

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
