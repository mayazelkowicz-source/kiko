import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getMessaging,
  getToken,
  isSupported as messagingSupported,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { firebaseConfig, vapidKey } from "./firebase-config.js";

// ---------- Config ----------
const PEOPLE = ["Mom", "Dad", "Shir", "Maya", "Noa", "Adi", "Yuval", "Tomer", "Guy"];

const ACTIONS = {
  pee:  { emoji: "💧",   label: "Pee",    text: "Peed" },
  poop: { emoji: "💩",   label: "Poop",   text: "Pooped" },
  both: { emoji: "💧💩", label: "Both",   text: "Peed & pooped" },
  walk: { emoji: "🐾",   label: "Walked", text: "Just walked" },
  run:  { emoji: "🏃",   label: "Run",    text: "Went for a run" },
};

const HISTORY_SIZE = 10;
const NUDGE_AFTER_HOURS = 5;
const LAST_PERSON_KEY = "kiko:lastPerson";
const DEVICE_KEY = "kiko:device";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  bell: $("bellBtn"),
  bellIcon: $("bellIcon"),
  bellLabel: $("bellLabel"),
  setupBanner: $("setupBanner"),
  hero: $("hero"),
  heroEmoji: $("heroEmoji"),
  heroAgo: $("heroAgo"),
  heroDetail: $("heroDetail"),
  heroTime: $("heroTime"),
  heroNudge: $("heroNudge"),
  champName: $("champName"),
  champCount: $("champCount"),
  people: $("people"),
  actions: $("actions"),
  submit: $("submitBtn"),
  history: $("historyList"),
  toast: $("toast"),
  toastMsg: $("toastMsg"),
  toastUndo: $("toastUndo"),
  sheet: $("sheet"),
  sheetEmoji: $("sheetEmoji"),
  sheetText: $("sheetText"),
  sheetDelete: $("sheetDelete"),
  sheetCancel: $("sheetCancel"),
};

// ---------- State ----------
const state = {
  person: safeGet(LAST_PERSON_KEY),
  action: null,
  walks: [],
  knownIds: new Set(),
  firstLoad: true,
  champSig: null,
};
let walksCol = null;
let devicesCol = null;
let pushToken = null;
if (!PEOPLE.includes(state.person)) state.person = null;

// ---------- Helpers ----------
function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
function vibrate(ms = 12) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

function timeAgo(date) {
  const sec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  const rem = min % 60;
  if (hrs < 24) return rem ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

function clock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(date) {
  const today = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(date)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

// ---------- Render: selectors ----------
function renderPeople() {
  els.people.replaceChildren(
    ...PEOPLE.map((name) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.person === name));
      b.textContent = name;
      b.addEventListener("click", () => {
        // Tap the selected name again to clear it.
        state.person = state.person === name ? null : name;
        safeSet(LAST_PERSON_KEY, state.person || "");
        vibrate();
        renderPeople();
        updateSubmit();
        saveDevice(); // so this phone doesn't get pinged for its own walks
      });
      return b;
    })
  );
}

function renderActions() {
  els.actions.replaceChildren(
    ...Object.entries(ACTIONS).map(([key, a]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "action";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.action === key));
      b.setAttribute("aria-label", a.label);
      b.innerHTML = `<span class="emoji"></span><span class="label"></span>`;
      b.querySelector(".emoji").textContent = a.emoji;
      b.querySelector(".label").textContent = a.label;
      b.addEventListener("click", () => {
        state.action = state.action === key ? null : key;
        vibrate();
        renderActions();
        updateSubmit();
      });
      return b;
    })
  );
}

function updateSubmit() {
  els.submit.disabled = !(state.person && state.action);
}

// ---------- Render: data ----------
function renderHero() {
  const last = state.walks[0];
  if (!last) {
    els.heroEmoji.textContent = "🐾";
    els.heroEmoji.classList.remove("duo");
    els.heroAgo.textContent = "No walks yet";
    els.heroDetail.textContent = "Be the first to take Kiko out!";
    els.heroTime.textContent = "";
    els.heroNudge.hidden = true;
    return;
  }
  const a = ACTIONS[last.action] || ACTIONS.walk;
  els.heroEmoji.textContent = a.emoji;
  els.heroEmoji.classList.toggle("duo", last.action === "both");
  els.heroAgo.textContent = timeAgo(last.date);
  els.heroDetail.textContent = `${last.person} · ${a.text}`;
  els.heroTime.textContent = `${dayLabel(last.date)} at ${clock(last.date)}`;
  els.heroNudge.hidden = Date.now() - last.date.getTime() < NUDGE_AFTER_HOURS * 3600_000;
}

const TRASH_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

function renderHistory(newIds = new Set()) {
  if (!state.walks.length) {
    els.history.innerHTML = `<li class="empty">Nothing here yet — go for a walk! 🐾</li>`;
    return;
  }
  els.history.replaceChildren(
    ...state.walks.map((w) => {
      const a = ACTIONS[w.action] || ACTIONS.walk;
      const li = document.createElement("li");
      if (newIds.has(w.id)) li.classList.add("new");
      li.innerHTML = `
        <div class="h-emoji"></div>
        <div class="h-body"><p class="h-who"></p><p class="h-what"></p></div>
        <div class="h-time"><span class="t"></span><small class="d"></small></div>
        <button type="button" class="h-del">${TRASH_ICON}</button>`;
      const em = li.querySelector(".h-emoji");
      em.textContent = a.emoji;
      em.classList.toggle("duo", w.action === "both");
      li.querySelector(".h-who").textContent = w.person;
      li.querySelector(".h-what").textContent = a.text;
      li.querySelector(".t").textContent = clock(w.date);
      li.querySelector(".d").textContent = dayLabel(w.date);

      const del = li.querySelector(".h-del");
      del.setAttribute("aria-label", `Delete ${w.person}'s walk`);
      del.addEventListener("click", () => openDeleteSheet(w));
      return li;
    })
  );
}

// ---------- Delete confirmation sheet ----------
let walkToDelete = null;

function openDeleteSheet(walk) {
  walkToDelete = walk;
  const a = ACTIONS[walk.action] || ACTIONS.walk;
  els.sheetEmoji.textContent = a.emoji;
  els.sheetText.textContent =
    `${walk.person} · ${a.text} · ${dayLabel(walk.date)} at ${clock(walk.date)}`;
  els.sheet.hidden = false;
  requestAnimationFrame(() => els.sheet.classList.add("open"));
  vibrate();
}

function closeDeleteSheet() {
  walkToDelete = null;
  els.sheet.classList.remove("open");
  setTimeout(() => { els.sheet.hidden = true; }, 250);
}

els.sheetCancel.addEventListener("click", closeDeleteSheet);
els.sheet.addEventListener("click", (e) => {
  if (e.target === els.sheet) closeDeleteSheet(); // tap outside
});
els.sheetDelete.addEventListener("click", () => {
  const walk = walkToDelete;
  closeDeleteSheet();
  if (!walk || !walksCol) return;
  vibrate([10, 30, 10]);
  deleteDoc(doc(walksCol, walk.id))
    .then(() => showToast(`🗑️ Removed ${walk.person}'s walk`))
    .catch((err) => {
      console.error(err);
      showToast(err.code === "permission-denied"
        ? "No permission to delete — check Firestore rules"
        : "Couldn't delete — try again");
    });
});

// ---------- Toast ----------
let toastTimer;
function showToast(msg, onUndo) {
  clearTimeout(toastTimer);
  els.toastMsg.textContent = msg;
  els.toastUndo.hidden = !onUndo;
  els.toastUndo.onclick = onUndo
    ? () => { onUndo(); hideToast(); }
    : null;
  els.toast.classList.add("show");
  toastTimer = setTimeout(hideToast, onUndo ? 5000 : 3000);
}
function hideToast() {
  els.toast.classList.remove("show");
}

// ---------- Init UI ----------
renderPeople();
renderActions();
updateSubmit();
renderHero();

const isConfigured = !String(firebaseConfig.apiKey || "").startsWith("PASTE");
if (!isConfigured) {
  els.setupBanner.hidden = false;
  els.status.textContent = "Not connected";
} else {
  startFirebase();
}

// Keep "x min ago" fresh
setInterval(renderHero, 30_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) renderHero();
});

// ---------- Firebase ----------
function startFirebase() {
  const app = initializeApp(firebaseConfig);

  let db;
  try {
    // Offline cache: works on bad signal, syncs when back online.
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch {
    db = getFirestore(app);
  }

  setupNotifications(app, db);

  walksCol = collection(db, "walks");
  const q = query(walksCol, orderBy("timestamp", "desc"), limit(HISTORY_SIZE));

  onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const walks = snap.docs.map((d) => {
        const data = d.data({ serverTimestamps: "estimate" });
        return {
          id: d.id,
          person: String(data.person || "Someone"),
          action: data.action,
          date: data.timestamp ? data.timestamp.toDate() : new Date(),
        };
      });

      const newIds = new Set();
      if (!state.firstLoad) {
        walks.forEach((w) => { if (!state.knownIds.has(w.id)) newIds.add(w.id); });
      }
      const topChanged = state.walks[0]?.id !== walks[0]?.id;

      state.walks = walks;
      state.knownIds = new Set(walks.map((w) => w.id));

      renderHero();
      renderHistory(newIds);

      if (topChanged && !state.firstLoad) {
        els.hero.classList.remove("flash");
        void els.hero.offsetWidth; // restart animation
        els.hero.classList.add("flash");
      }
      state.firstLoad = false;

      // Recount once the server has the change (new walk or a delete).
      const sig = walks.map((w) => w.id).join();
      if (!snap.metadata.hasPendingWrites && sig !== state.champSig) {
        state.champSig = sig;
        refreshChampion();
      }

      const offline = snap.metadata.fromCache;
      els.status.textContent = offline ? "Offline · will sync" : "Live · synced with family";
      els.status.classList.toggle("live", !offline);
    },
    (err) => {
      console.error(err);
      els.status.textContent = "Connection error";
      els.status.classList.remove("live");
      showToast(err.code === "permission-denied"
        ? "No permission — check Firestore rules"
        : "Couldn't load walks");
    }
  );

  els.submit.addEventListener("click", () => {
    if (!state.person || !state.action) return;

    // Create the ref locally so the UI updates instantly, even offline.
    const ref = doc(walksCol);
    const action = state.action;
    setDoc(ref, {
      person: state.person,
      action,
      timestamp: serverTimestamp(),
    }).catch((err) => {
      console.error(err);
      showToast("Couldn't save — try again");
    });

    vibrate([10, 40, 20]);
    celebrate();
    showToast(`${ACTIONS[action].emoji} Walk logged — thanks, ${state.person}!`, () => {
      deleteDoc(ref).catch(console.error);
    });

    // Reset action, keep the person (usually the same phone = same person).
    state.action = null;
    renderActions();
  });
}

// ---------- Champion ----------
// One cheap count query per person, over all walks ever logged.
async function refreshChampion() {
  try {
    const counts = await Promise.all(PEOPLE.map(async (name) => {
      const snap = await getCountFromServer(query(walksCol, where("person", "==", name)));
      return { name, count: snap.data().count };
    }));
    const top = Math.max(...counts.map((c) => c.count));
    if (top === 0) {
      els.champName.textContent = "No champion yet";
      els.champCount.textContent = "Log a walk to take the crown!";
      return;
    }
    const leaders = counts.filter((c) => c.count === top).map((c) => c.name);
    els.champName.textContent = leaders.join(" & ");
    els.champCount.textContent =
      `${top} ${top === 1 ? "outing" : "outings"} with Kiko${leaders.length > 1 ? " · it's a tie!" : ""}`;
  } catch (err) {
    console.error(err); // counts need a connection; keep whatever is shown
  }
}

// ---------- Notifications ----------
// Each phone that turns alerts on stores its push token in /devices/{id}.
// A Cloud Function (functions/index.js) pings every device when a walk is logged,
// skipping devices whose selected person is the one who logged it.
function deviceId() {
  let id = safeGet(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
    safeSet(DEVICE_KEY, id);
  }
  return id;
}

function saveDevice() {
  if (!devicesCol || !pushToken) return Promise.resolve();
  return setDoc(doc(devicesCol, deviceId()), {
    token: pushToken,
    person: state.person || null,
    updatedAt: serverTimestamp(),
  }).catch(console.error);
}

function renderBell(on) {
  els.bell.hidden = false;
  els.bell.classList.toggle("on", on);
  els.bellIcon.textContent = on ? "🔔" : "🔕";
  els.bellLabel.textContent = on ? "Alerts on" : "Get alerts";
}

async function setupNotifications(app, db) {
  if (!vapidKey || vapidKey.startsWith("PASTE")) return; // not set up yet

  const supported = "serviceWorker" in navigator && "Notification" in window
    && (await messagingSupported().catch(() => false));
  if (!supported) {
    // iPhone only allows web notifications once the app is on the Home Screen.
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      renderBell(false);
      els.bell.onclick = () =>
        showToast("On iPhone: Share → Add to Home Screen, then open Kiko from there");
    }
    return;
  }

  const messaging = getMessaging(app);
  devicesCol = collection(db, "devices");

  async function subscribe() {
    const registration = await navigator.serviceWorker.register("./sw.js");
    pushToken = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
    await saveDevice();
  }

  const granted = Notification.permission === "granted";
  renderBell(granted);
  if (granted) subscribe().catch(console.error); // refresh token on every launch

  els.bell.onclick = async () => {
    vibrate();
    if (Notification.permission === "granted" && pushToken) {
      showToast("🔔 You'll get a ping whenever Kiko goes out");
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      showToast("Notifications are blocked — allow them in your phone settings");
      return;
    }
    try {
      await subscribe();
      renderBell(true);
      showToast("🔔 Alerts on! You'll know when Kiko goes out");
    } catch (err) {
      console.error(err);
      showToast("Couldn't turn on alerts — try again");
    }
  };
}

function celebrate() {
  const label = els.submit.querySelector(".cta-label");
  els.submit.classList.add("success");
  els.submit.disabled = true;
  label.textContent = "Done! 🐶";
  setTimeout(() => {
    els.submit.classList.remove("success");
    label.textContent = "Update Walk";
    updateSubmit();
  }, 1400);
}
