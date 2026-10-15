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
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- Config ----------
const PEOPLE = ["Mom", "Dad", "Shir", "Maya", "Noa", "Adi"];

const ACTIONS = {
  pee:  { emoji: "💧",   label: "Pee",    text: "Peed" },
  poop: { emoji: "💩",   label: "Poop",   text: "Pooped" },
  both: { emoji: "💧💩", label: "Both",   text: "Peed & pooped" },
  walk: { emoji: "🐾",   label: "Walked", text: "Just walked" },
};

const HISTORY_SIZE = 10;
const NUDGE_AFTER_HOURS = 5;
const LAST_PERSON_KEY = "kiko:lastPerson";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  setupBanner: $("setupBanner"),
  hero: $("hero"),
  heroEmoji: $("heroEmoji"),
  heroAgo: $("heroAgo"),
  heroDetail: $("heroDetail"),
  heroTime: $("heroTime"),
  heroNudge: $("heroNudge"),
  people: $("people"),
  actions: $("actions"),
  submit: $("submitBtn"),
  history: $("historyList"),
  toast: $("toast"),
  toastMsg: $("toastMsg"),
  toastUndo: $("toastUndo"),
};

// ---------- State ----------
const state = {
  person: safeGet(LAST_PERSON_KEY),
  action: null,
  walks: [],
  knownIds: new Set(),
  firstLoad: true,
  pendingDeleteId: null,
};
let walksCol = null;
let pendingDeleteTimer;
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
    els.heroAgo.textContent = "No walks yet";
    els.heroDetail.textContent = "Be the first to take Kiko out!";
    els.heroTime.textContent = "";
    els.heroNudge.hidden = true;
    return;
  }
  const a = ACTIONS[last.action] || ACTIONS.walk;
  els.heroEmoji.textContent = a.emoji;
  els.heroAgo.textContent = timeAgo(last.date);
  els.heroDetail.textContent = `${last.person} · ${a.text}`;
  els.heroTime.textContent = `${dayLabel(last.date)} at ${clock(last.date)}`;
  els.heroNudge.hidden = Date.now() - last.date.getTime() < NUDGE_AFTER_HOURS * 3600_000;
}

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
        <button type="button" class="h-del"></button>`;
      li.querySelector(".h-emoji").textContent = a.emoji;
      li.querySelector(".h-who").textContent = w.person;
      li.querySelector(".h-what").textContent = a.text;
      li.querySelector(".t").textContent = clock(w.date);
      li.querySelector(".d").textContent = dayLabel(w.date);

      const del = li.querySelector(".h-del");
      const confirming = state.pendingDeleteId === w.id;
      del.classList.toggle("confirm", confirming);
      del.textContent = confirming ? "Delete" : "✕";
      del.setAttribute("aria-label", confirming ? "Confirm delete" : `Remove ${w.person}'s walk`);
      del.addEventListener("click", () => onDeleteTap(w, li));
      return li;
    })
  );
}

// Two taps to delete: ✕ turns into "Delete", tap again to confirm.
function onDeleteTap(walk, li) {
  if (!walksCol) return;
  clearTimeout(pendingDeleteTimer);
  if (state.pendingDeleteId !== walk.id) {
    state.pendingDeleteId = walk.id;
    vibrate();
    renderHistory();
    pendingDeleteTimer = setTimeout(() => {
      state.pendingDeleteId = null;
      renderHistory();
    }, 3000);
    return;
  }
  state.pendingDeleteId = null;
  li.classList.add("removing");
  vibrate([10, 30, 10]);
  deleteDoc(doc(walksCol, walk.id))
    .then(() => showToast(`Removed ${walk.person}'s walk`))
    .catch((err) => {
      console.error(err);
      li.classList.remove("removing");
      showToast("Couldn't delete — try again");
    });
}

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
