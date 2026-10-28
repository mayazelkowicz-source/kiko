// Sends a push to every family phone when a walk is logged.
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const ACTIONS = {
  pee:  { emoji: "💧",   text: "Kiko peed" },
  poop: { emoji: "💩",   text: "Kiko pooped" },
  both: { emoji: "💧💩", text: "Kiko peed & pooped" },
  walk: { emoji: "🐾",   text: "Kiko went for a walk" },
  run:  { emoji: "🏃",   text: "Kiko went for a run" },
};

const DEAD_TOKEN_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

exports.notifyFamily = onDocumentCreated("walks/{walkId}", async (event) => {
  const walk = event.data?.data();
  if (!walk) return;

  const db = getFirestore();
  const devices = (await db.collection("devices").get()).docs
    // Don't ping the person who just logged it.
    .filter((d) => d.get("token") && d.get("person") !== walk.person);
  if (!devices.length) return;

  const a = ACTIONS[walk.action] || ACTIONS.walk;
  const res = await getMessaging().sendEachForMulticast({
    tokens: devices.map((d) => d.get("token")),
    data: {
      title: `${a.emoji} ${a.text}`,
      body: `${walk.person || "Someone"} took Kiko out`,
    },
    webpush: { headers: { Urgency: "high", TTL: "3600" } },
  });

  // Clean up phones that uninstalled or turned notifications off.
  await Promise.all(res.responses.map((r, i) =>
    !r.success && DEAD_TOKEN_ERRORS.has(r.error?.code)
      ? devices[i].ref.delete()
      : null
  ));
});
