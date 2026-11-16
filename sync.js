/* ============================================================
   Firebase sync layer for the Workshop app (BIS CO.)
   - Load it AFTER the main inline script:  <script src="sync.js"></script>
   - Admin edits are pushed to Firestore; every other device
     receives them live (and on next open).
   - Syncs: tree, users, texts, passwords hash, default theme,
            card/zone/banner images, and uploaded files (chunked).
   ============================================================ */
(function () {
  "use strict";

  /* ---------- 1) FILL THESE IN (from Firebase console) ---------- */
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBntu5haYjm4HP7kzYOQdg5xnLzyVie5Zk",
    authDomain: "mostafa-cc8de.firebaseapp.com",
    projectId: "mostafa-cc8de",
    appId: "1:272527666259:web:52413c2eca4d020a942aa6"
  };
  const ADMIN_EMAIL = "mostafaja4113@gmail.com";   // the Firebase Auth user that is allowed to write
  /* -------------------------------------------------------------- */

  if (FIREBASE_CONFIG.apiKey.indexOf("PASTE") === 0) { console.warn("sync.js: Firebase config not filled in"); return; }

  const V = "10.12.2";
  const SYNC_KEYS = ["tree", "deleted", "users", "texts", "pinhash", "ownername", "themedefault"];
  const MAX_FILE_SYNC = 15 * 1024 * 1024;       // files above this stay on the admin phone only
  const CHUNK = 600000;                          // raw bytes per Firestore doc (base64 stays < 1 MB)
  const FORCE = /[?&]forcepush\b/.test(location.search);

  const origSet = Storage.prototype.setItem;
  const origRem = Storage.prototype.removeItem;

  let fb = null, auth = null, authed = false, authReady = false, asked = false;
  let applying = false, ready = false, remoteEmpty = false, lastRev = null;
  let dirty = new Set(), timer = null, renderT = null;
  let upBusy = false, dlBusy = false, dlAgain = false, initDone = false;
  const remoteIdx = new Map();                   // file id -> {n, type, size}

  const isAdmin = () => typeof admin !== "undefined" && admin === true;
  const say = (m, ms) => { try { if (typeof toast === "function") toast(m, ms || 3000); } catch (e) {} };

  /* ---------- watch localStorage writes (no change needed in the app) ---------- */
  function mark(k) {
    if (SYNC_KEYS.indexOf(k) >= 0 || k.indexOf("img_") === 0) { dirty.add(k); schedule(); }
  }
  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === localStorage && !applying) mark(k);
  };
  Storage.prototype.removeItem = function (k) {
    origRem.call(this, k);
    if (this === localStorage && !applying) mark(k);
  };
  function schedule() { clearTimeout(timer); timer = setTimeout(flush, 1500); }

  /* ---------- helpers ---------- */
  function b64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return btoa(s);
  }
  function unb64(s) {
    const b = atob(s), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function refIds() {
    const ids = new Set();
    const rec = n => {
      try { allFiles(n).forEach(f => { if (f && f.id) ids.add(f.id); }); } catch (e) {}
      (n.children || []).forEach(rec);
    };
    (tree || []).forEach(rec);
    return ids;
  }
  function rerenderSoon() {
    clearTimeout(renderT);
    renderT = setTimeout(() => { try { render(); } catch (e) { console.error(e); } }, 400);
  }

  /* ---------- push (admin only) ---------- */
  async function pushState() {
    const o = {};
    SYNC_KEYS.forEach(k => { o[k] = localStorage.getItem(k); });
    const rev = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    lastRev = rev;
    o.rev = rev;
    await fb.setDoc(fb.doc(fb.db, "app", "state"), o);
  }
  async function flush() {
    if (!ready || !authed || !isAdmin() || !dirty.size) return;
    const keys = Array.from(dirty);
    dirty = new Set();
    try {
      let needState = false;
      for (const k of keys) {
        if (k.indexOf("img_") === 0) {
          const v = localStorage.getItem(k);
          const ref = fb.doc(fb.db, "imgs", encodeURIComponent(k));
          if (v == null) await fb.deleteDoc(ref);
          else await fb.setDoc(ref, { k: k, data: v });
        } else needState = true;
      }
      if (needState) await pushState();
      await syncFilesUp();
    } catch (e) {
      console.error("sync push failed", e);
      keys.forEach(k => dirty.add(k));
      setTimeout(schedule, 15000);
    }
  }
  async function pushAll() {
    if (!authed || !isAdmin()) return;
    say("Uploading data to server...", 0);
    try {
      await pushState();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("img_") === 0) {
          await fb.setDoc(fb.doc(fb.db, "imgs", encodeURIComponent(k)), { k: k, data: localStorage.getItem(k) });
        }
      }
      await syncFilesUp();
      say("Data uploaded to server", 4000);
    } catch (e) {
      console.error(e);
      say("Upload failed - check connection / rules", 6000);
    }
  }

  /* ---------- files: upload (admin) / download (everyone) ---------- */
  async function uploadFile(id, blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const n = Math.max(1, Math.ceil(buf.length / CHUNK));
    for (let i = 0; i < n; i++) {
      await fb.setDoc(fb.doc(fb.db, "fchunks", id + "_" + i), { d: b64(buf.subarray(i * CHUNK, (i + 1) * CHUNK)) });
    }
    await fb.setDoc(fb.doc(fb.db, "files", id), { n: n, type: blob.type || "", size: buf.length });
  }
  async function syncFilesUp() {
    if (upBusy || !authed || !isAdmin()) return;
    upBusy = true;
    try {
      for (const id of refIds()) {
        if (remoteIdx.has(id)) continue;
        const blob = await dbGet(id);
        if (!blob) continue;
        if (blob.size > MAX_FILE_SYNC) { console.warn("file too large to sync", id, blob.size); continue; }
        await uploadFile(id, blob);
        remoteIdx.set(id, { n: 1, type: blob.type, size: blob.size });
      }
    } catch (e) { console.error("file upload failed", e); }
    upBusy = false;
  }
  async function downloadMissing() {
    if (dlBusy) { dlAgain = true; return; }
    dlBusy = true;
    try {
      for (const id of refIds()) {
        const m = remoteIdx.get(id);
        if (!m) continue;
        const have = await dbGet(id);
        if (have) continue;
        const parts = [];
        for (let i = 0; i < m.n; i++) {
          const s = await fb.getDoc(fb.doc(fb.db, "fchunks", id + "_" + i));
          if (!s.exists()) throw new Error("missing chunk " + id + "_" + i);
          parts.push(unb64(s.data().d));
        }
        await dbPut(id, new Blob(parts, { type: m.type || "" }));
        rerenderSoon();
      }
    } catch (e) { console.error("file download failed", e); }
    dlBusy = false;
    if (dlAgain) { dlAgain = false; downloadMissing(); }
  }

  /* ---------- apply remote state locally ---------- */
  function applyState(st) {
    applying = true;
    try {
      SYNC_KEYS.forEach(k => {
        if (st[k] == null) origRem.call(localStorage, k);
        else origSet.call(localStorage, k, st[k]);
      });
      const arr = (k, d) => { try { const v = JSON.parse(st[k]); return Array.isArray(v) ? v : d; } catch (e) { return d; } };
      tree = arr("tree", []);
      deleted = arr("deleted", []);
      users = arr("users", []);
      try { const t = JSON.parse(st.texts); texts = (t && typeof t === "object") ? t : {}; } catch (e) { texts = {}; }
      merge(tree, seed());
      try { applyTheme(); } catch (e) {}
    } finally { applying = false; }
    rerenderSoon();
  }

  /* ---------- admin sign-in to Firebase (once per device) ---------- */
  async function adminSignIn() {
    const pw = prompt("Server (Firebase) admin password - asked once on this device:");
    if (!pw) return;
    try { await auth.signIn(auth.auth, ADMIN_EMAIL, pw); }
    catch (e) { alert("Server login failed: " + (e && e.code ? e.code : e)); }
  }
  setInterval(function () {
    if (!fb || !authReady) return;
    if (!isAdmin()) { asked = false; return; }
    if (!authed && !asked) { asked = true; adminSignIn(); }
  }, 1500);

  function maybeInit() {
    if (initDone || !ready || !authed || !isAdmin()) return;
    if (remoteEmpty || FORCE) { initDone = true; pushAll(); }
    else { initDone = true; schedule(); }
  }

  /* ---------- start ---------- */
  (async function start() {
    try {
      const base = "https://www.gstatic.com/firebasejs/" + V + "/";
      const mods = await Promise.all([
        import(base + "firebase-app.js"),
        import(base + "firebase-firestore.js"),
        import(base + "firebase-auth.js")
      ]);
      const app = mods[0].initializeApp(FIREBASE_CONFIG);
      const F = mods[1], A = mods[2];
      fb = {
        db: F.getFirestore(app), doc: F.doc, collection: F.collection, getDoc: F.getDoc,
        setDoc: F.setDoc, deleteDoc: F.deleteDoc, onSnapshot: F.onSnapshot
      };
      auth = { auth: A.getAuth(app), signIn: A.signInWithEmailAndPassword };
      A.onAuthStateChanged(auth.auth, function (u) {
        authReady = true;
        authed = !!u && u.email === ADMIN_EMAIL;
        maybeInit();
        if (authed) schedule();
      });

      /* main state */
      fb.onSnapshot(fb.doc(fb.db, "app", "state"), function (snap) {
        if (!snap.exists()) { remoteEmpty = true; ready = true; maybeInit(); return; }
        remoteEmpty = false;
        const st = snap.data();
        if (st.rev !== lastRev) {
          if (!(isAdmin() && dirty.size)) { applyState(st); lastRev = st.rev; }
        }
        ready = true;
        maybeInit();
        downloadMissing();
      }, function (e) { console.error("state listener", e); });

      /* images (card icons, zone and banner photos) */
      fb.onSnapshot(fb.collection(fb.db, "imgs"), function (snap) {
        let changed = false;
        applying = true;
        try {
          snap.docChanges().forEach(function (ch) {
            const d = ch.doc.data();
            if (!d || !d.k) return;
            if (ch.type === "removed") { if (localStorage.getItem(d.k) != null) { origRem.call(localStorage, d.k); changed = true; } }
            else if (localStorage.getItem(d.k) !== d.data) { origSet.call(localStorage, d.k, d.data); changed = true; }
          });
        } finally { applying = false; }
        if (changed) rerenderSoon();
      }, function (e) { console.error("img listener", e); });

      /* file index */
      fb.onSnapshot(fb.collection(fb.db, "files"), function (snap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type === "removed") remoteIdx.delete(ch.doc.id);
          else remoteIdx.set(ch.doc.id, ch.doc.data());
        });
        downloadMissing();
        if (authed && isAdmin()) syncFilesUp();
      }, function (e) { console.error("files listener", e); });
    } catch (e) {
      console.warn("sync.js: could not start (offline?)", e);
    }
  })();

  window.syncPushNow = pushAll;
})();
