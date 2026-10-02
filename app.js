/* =========================================================
   Mac Notes
   Vanilla JavaScript + localStorage + CryptoJS
   ---------------------------------------------------------
   Storage keys:
   - macNotes.publicNotes  -> readable public notes
   - macNotes.vault        -> encrypted vault payload
   - macNotes.vaultHash    -> SHA-256 hash used to verify passcode
   - macNotes.preferences  -> UI preferences only
   ========================================================= */

(() => {
  "use strict";

  const KEYS = {
    publicNotes: "macNotes.publicNotes.v1",
    vault: "macNotes.vault.v1",
    vaultHash: "macNotes.vaultHash.v1",
    preferences: "macNotes.preferences.v1",
    pending: "macNotes.syncPending.v1",
    cloudVault: "macNotes.cloudVault.v1",
    migratedUsers: "macNotes.migratedUsers.v1"
  };

  const DEFAULT_PREFS = {
    vaultTrigger: "::vault",
    lastPublicNoteId: null
  };

  const state = {
    publicNotes: [],
    vaultNotes: [],
    vaultUnlocked: false,
    vaultPasscode: "",
    activeMode: "public", // "public" or "vault"
    activeNoteId: null,
    filter: "all",
    query: "",
    saveTimer: null,
    prefs: { ...DEFAULT_PREFS },
    supabase: null,
    user: null,
    pending: [],
    syncBusy: false,
    cloudVaultRows: [],
    handledUserId: null
  };

  // ---------- DOM ----------
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const noteList = $("#noteList");
  const searchInput = $("#searchInput");
  const noteTitle = $("#noteTitle");
  const categoryInput = $("#categoryInput");
  const tagsInput = $("#tagsInput");
  const editor = $("#editor");
  const editorWrap = $("#editorWrap");
  const emptyState = $("#emptyState");
  const saveState = $("#saveState");
  const updatedAt = $("#updatedAt");
  const wordCount = $("#wordCount");
  const modePill = $("#modePill");
  const privacyBadge = $("#privacyBadge");
  const storageStatus = $("#storageStatus");
  const noteListStatus = $("#noteListStatus");
  const appShell = $("#appShell");
  const mobileMenuBtn = $("#mobileMenuBtn");
  const sidebarBackdrop = $("#sidebarBackdrop");
  const syncStatus = $("#syncStatus");
  const accountBtn = $("#accountBtn");
  const accountLabel = $("#accountLabel");

  const mobileSidebarQuery = window.matchMedia("(max-width: 620px)");

  function isMobileSidebar() {
    return mobileSidebarQuery.matches;
  }

  function setMobileSidebar(open) {
    if (!isMobileSidebar()) return;
    appShell.classList.toggle("sidebar-open", open);
    sidebarBackdrop.classList.toggle("is-open", open);
    mobileMenuBtn.setAttribute("aria-expanded", String(open));
    mobileMenuBtn.setAttribute("aria-label", open ? "Close notes sidebar" : "Open notes sidebar");
  }

  function closeMobileSidebar() {
    setMobileSidebar(false);
  }

  const vaultDialog = $("#vaultDialog");
  const vaultForm = $("#vaultForm");
  const vaultDialogTitle = $("#vaultDialogTitle");
  const vaultDialogText = $("#vaultDialogText");
  const vaultPasscodeInput = $("#vaultPasscodeInput");
  const vaultConfirmWrap = $("#vaultConfirmWrap");
  const vaultConfirmInput = $("#vaultConfirmInput");
  const vaultSubmitBtn = $("#vaultSubmitBtn");
  const vaultError = $("#vaultError");

  const settingsDialog = $("#settingsDialog");
  const confirmDialog = $("#confirmDialog");
  const toast = $("#toast");

  // ---------- Helpers ----------
  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  const nowIso = () => new Date().toISOString();

  const escapeHtml = (value = "") =>
    value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));

  const stripHtml = (html = "") => {
    const temp = document.createElement("div");
    temp.innerHTML = html;
    return (temp.textContent || temp.innerText || "").replace(/\s+/g, " ").trim();
  };

  const normalizeTags = (value = "") =>
    value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12);

  const formatDate = (iso) => {
    if (!iso) return "";
    const date = new Date(iso);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();

    if (sameDay) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined
    });
  };

  const safeParse = (raw, fallback) => {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function refreshIcons() {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  // ---------- Encryption ----------
  function sha256(value) {
    return CryptoJS.SHA256(value).toString();
  }

  function encryptObject(object, passcode) {
    const json = JSON.stringify(object);
    return CryptoJS.AES.encrypt(json, passcode).toString();
  }

  function decryptObject(cipherText, passcode) {
    const bytes = CryptoJS.AES.decrypt(cipherText, passcode);
    const text = bytes.toString(CryptoJS.enc.Utf8);
    if (!text) throw new Error("Unable to decrypt vault.");
    return JSON.parse(text);
  }

  function vaultExists() {
    return Boolean(localStorage.getItem(KEYS.vaultHash)) || state.cloudVaultRows.length > 0;
  }

  function verifyVaultPasscode(passcode) {
    return sha256(passcode) === localStorage.getItem(KEYS.vaultHash);
  }

  function persistVault() {
    if (!state.vaultUnlocked || !state.vaultPasscode) return;
    const encrypted = encryptObject(state.vaultNotes, state.vaultPasscode);
    localStorage.setItem(KEYS.vault, encrypted);
  }

  // ---------- Storage ----------
  function loadStorage() {
    state.publicNotes = safeParse(localStorage.getItem(KEYS.publicNotes), []);
    state.cloudVaultRows = safeParse(localStorage.getItem(KEYS.cloudVault), []);
    state.prefs = {
      ...DEFAULT_PREFS,
      ...safeParse(localStorage.getItem(KEYS.preferences), {})
    };

    // Add one welcome note only on first launch.
    if (!localStorage.getItem(KEYS.publicNotes)) {
      const welcome = createBlankNote(false);
      welcome.title = "Welcome to Mac Notes";
      welcome.category = "Getting Started";
      welcome.tags = ["welcome", "notes"];
      welcome.content = `
        <h2>Your lightweight notes workspace</h2>
        <p>This app stores public notes locally in your browser. Private vault notes are encrypted before they are stored.</p>
        <p><strong>Shortcuts:</strong> Ctrl+N creates a note, Ctrl+S saves, Ctrl+F searches, and Ctrl+L locks the vault.</p>
        <p>Use the gold shield button to move a note into your private vault.</p>
      `;
      state.publicNotes = [welcome];
      persistPublic();
    }
  }

  function persistPublic() {
    localStorage.setItem(KEYS.publicNotes, JSON.stringify(state.publicNotes));
  }

  function persistPrefs() {
    localStorage.setItem(KEYS.preferences, JSON.stringify(state.prefs));
  }

  function updateStorageDisplay() {
    let bytes = 0;
    for (const key of Object.values(KEYS)) {
      bytes += (localStorage.getItem(key) || "").length * 2;
    }
    const kb = bytes / 1024;
    const text = kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`;
    $("#storageDetail").textContent = `Approximate app storage used: ${text}`;
    storageStatus.textContent = `Saved locally · ${text}`;
  }

  // ---------- Cloud sync ----------
  function configuredSupabase() {
    const config = window.MAC_NOTES_SUPABASE_CONFIG;
    return Boolean(config?.url && config?.anonKey && !config.url.includes("YOUR_") && window.supabase);
  }

  function setSyncStatus(status) {
    const labels = { local: "Local only", saving: "Saving…", synced: "Synced", offline: "Offline", error: "Sync error" };
    syncStatus.textContent = labels[status] || status;
    syncStatus.dataset.state = status;
  }

  function updateAccountUi() {
    accountLabel.textContent = state.user ? (state.user.email || "Account") : "Sign in";
    accountBtn.title = state.user ? "Account and sync" : "Sign in to sync notes";
    accountBtn.classList.toggle("signed-in", Boolean(state.user));
  }

  function rowForNote(note) {
    if (note.vault) {
      if (!state.vaultPasscode) throw new Error("Unlock the vault before syncing private notes.");
      return { id: note.id, user_id: state.user.id, title: "", content: "", category: "", tags: [], pinned: false,
        is_vault: true, encrypted_payload: encryptObject(note, state.vaultPasscode), created_at: note.createdAt, updated_at: note.updatedAt };
    }
    return { id: note.id, user_id: state.user.id, title: note.title || "", content: note.content || "", category: note.category || "",
      tags: note.tags || [], pinned: Boolean(note.pinned), is_vault: false, encrypted_payload: null, created_at: note.createdAt, updated_at: note.updatedAt };
  }

  function noteFromRow(row) {
    return { id: row.id, title: row.title || "", content: row.content || "", category: row.category || "", tags: Array.isArray(row.tags) ? row.tags : [],
      pinned: Boolean(row.pinned), vault: false, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function pendingKey() { return `${KEYS.pending}:${state.user?.id || "anonymous"}`; }
  function savePending() { localStorage.setItem(pendingKey(), JSON.stringify(state.pending)); }
  function queueOperation(operation) {
    if (!state.user) return;
    state.pending = state.pending.filter((item) => !(item.type === operation.type && item.id === operation.id));
    state.pending.push(operation);
    savePending();
    syncPending();
  }
  function queueUpsert(note) {
    if (!state.user) return;
    try { queueOperation({ type: "upsert", id: note.id, row: rowForNote(note) }); }
    catch (error) { setSyncStatus("error"); showToast(error.message); }
  }
  function queueDelete(id) { if (state.user) queueOperation({ type: "delete", id }); }

  async function syncPending() {
    if (!state.supabase || !state.user) { setSyncStatus("local"); return; }
    if (!navigator.onLine) { setSyncStatus("offline"); return; }
    if (state.syncBusy || !state.pending.length) { if (!state.pending.length) setSyncStatus("synced"); return; }
    state.syncBusy = true; setSyncStatus("saving");
    try {
      while (state.pending.length) {
        const operation = state.pending[0];
        if (operation.type === "delete") {
          const { error } = await state.supabase.from("notes").delete().eq("id", operation.id);
          if (error) throw error;
        } else {
          const { data: remote, error: readError } = await state.supabase.from("notes").select("updated_at").eq("id", operation.id).maybeSingle();
          if (readError) throw readError;
          if (remote && new Date(remote.updated_at) > new Date(operation.row.updated_at)) {
            state.pending.shift(); savePending(); setSyncStatus("error"); showToast("Sync conflict: newer cloud note kept"); continue;
          }
          const { error } = await state.supabase.from("notes").upsert(operation.row, { onConflict: "id" });
          if (error) throw error;
        }
        state.pending.shift(); savePending();
      }
      setSyncStatus("synced");
    } catch (error) { console.error("Sync failed", error); setSyncStatus(navigator.onLine ? "error" : "offline"); }
    finally { state.syncBusy = false; }
  }

  async function loadCloudNotes() {
    if (!state.supabase || !state.user || !navigator.onLine) return;
    setSyncStatus("saving");
    const { data, error } = await state.supabase.from("notes").select("*").order("updated_at", { ascending: false });
    if (error) { console.error(error); setSyncStatus("error"); return; }
    const publicRows = data.filter((row) => !row.is_vault);
    state.cloudVaultRows = data.filter((row) => row.is_vault);
    localStorage.setItem(KEYS.cloudVault, JSON.stringify(state.cloudVaultRows));
    if (publicRows.length) { state.publicNotes = publicRows.map(noteFromRow); persistPublic(); }
    renderAll(); setSyncStatus("synced");
  }

  async function migrateLocalNotes() {
    flushActiveNote();
    if (!state.user) return;
    const notes = [...state.publicNotes];
    if (state.vaultUnlocked) notes.push(...state.vaultNotes);
    if (!notes.length) { markMigrated(); return; }
    setSyncStatus("saving");
    try {
      const rows = notes.map(rowForNote);
      const { error } = await state.supabase.from("notes").upsert(rows, { onConflict: "id" });
      if (error) throw error;
      const { data, error: verifyError } = await state.supabase.from("notes").select("id").in("id", notes.map((note) => note.id));
      if (verifyError || data.length !== notes.length) throw verifyError || new Error("Migration verification failed");
      markMigrated(); state.pending = []; savePending(); setSyncStatus("synced"); showToast("Local notes migrated and verified");
    } catch (error) { console.error(error); setSyncStatus("error"); showToast("Migration failed; local notes were kept"); }
  }
  function migrationKey() { return `${KEYS.migratedUsers}:${state.user?.id || ""}`; }
  function markMigrated() { localStorage.setItem(migrationKey(), "true"); }
  function hasLocalNotes() {
    return state.publicNotes.some((note) => note.title !== "Welcome to Mac Notes") || Boolean(localStorage.getItem(KEYS.vault));
  }

  function setupRealtime() {
    if (!state.supabase || !state.user) return;
    state.supabase.removeAllChannels();
    state.supabase.channel(`notes:${state.user.id}`).on("postgres_changes", {
      event: "*", schema: "public", table: "notes", filter: `user_id=eq.${state.user.id}`
    }, (change) => {
      if (change.eventType === "DELETE") {
        state.publicNotes = state.publicNotes.filter((note) => note.id !== change.old.id);
        state.cloudVaultRows = state.cloudVaultRows.filter((row) => row.id !== change.old.id);
        if (state.vaultUnlocked) state.vaultNotes = state.vaultNotes.filter((note) => note.id !== change.old.id);
        localStorage.setItem(KEYS.cloudVault, JSON.stringify(state.cloudVaultRows));
      } else if (change.new.is_vault) {
        state.cloudVaultRows = [...state.cloudVaultRows.filter((row) => row.id !== change.new.id), change.new];
        localStorage.setItem(KEYS.cloudVault, JSON.stringify(state.cloudVaultRows));
      } else {
        const incoming = noteFromRow(change.new);
        const local = state.publicNotes.find((note) => note.id === incoming.id);
        if (!local || new Date(incoming.updatedAt) >= new Date(local.updatedAt)) {
          state.publicNotes = [incoming, ...state.publicNotes.filter((note) => note.id !== incoming.id)];
          persistPublic();
        }
      }
      renderAll(); setSyncStatus("synced");
    }).subscribe();
  }

  async function handleSignedIn() {
    if (!state.user || state.handledUserId === state.user.id) return;
    state.handledUserId = state.user.id;
    state.pending = safeParse(localStorage.getItem(pendingKey()), []);
    updateAccountUi();
    setupRealtime();
    if (hasLocalNotes() && !localStorage.getItem(migrationKey())) {
      $("#migrationText").textContent = state.vaultUnlocked
        ? "Your local public and unlocked vault notes can be uploaded. Vault notes remain encrypted before upload. Local copies stay until verification succeeds."
        : "Your local public notes can be uploaded now. Unlock the vault first if you also want to migrate private notes. Local copies stay until verification succeeds.";
      if (!$("#migrationDialog").open) $("#migrationDialog").showModal();
    } else { await loadCloudNotes(); await syncPending(); }
  }

  async function initCloud() {
    if (!configuredSupabase()) { setSyncStatus("local"); updateAccountUi(); return; }
    const config = window.MAC_NOTES_SUPABASE_CONFIG;
    state.supabase = window.supabase.createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data: { session } } = await state.supabase.auth.getSession();
    state.user = session?.user || null; updateAccountUi();
    state.supabase.auth.onAuthStateChange((_event, session) => { state.user = session?.user || null; updateAccountUi(); if (state.user) handleSignedIn(); else { state.handledUserId = null; setSyncStatus("local"); }; });
    if (state.user) await handleSignedIn(); else setSyncStatus("local");
  }

  // ---------- Notes ----------
  function createBlankNote(isVault) {
    const now = nowIso();
    return {
      id: uid(),
      title: "",
      content: "",
      category: "",
      tags: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
      vault: Boolean(isVault)
    };
  }

  function getCurrentCollection() {
    return state.activeMode === "vault" ? state.vaultNotes : state.publicNotes;
  }

  function getActiveNote() {
    return getCurrentCollection().find((note) => note.id === state.activeNoteId) || null;
  }

  function createNewNote(forceVault = false) {
    const wantsVault = forceVault || state.activeMode === "vault";

    if (wantsVault && !state.vaultUnlocked) {
      openVaultDialog("unlock", () => createNewNote(true));
      return;
    }

    flushActiveNote();

    const note = createBlankNote(wantsVault);
    if (wantsVault) {
      state.vaultNotes.unshift(note);
      state.activeMode = "vault";
      persistVault();
    } else {
      state.publicNotes.unshift(note);
      state.activeMode = "public";
      persistPublic();
      state.prefs.lastPublicNoteId = note.id;
      persistPrefs();
    }

    state.activeNoteId = note.id;
    queueUpsert(note);
    state.filter = wantsVault ? "vault" : "all";
    syncFilterButtons();
    renderAll();
    noteTitle.focus();
    closeMobileSidebar();
  }

  function selectNote(id, mode) {
    flushActiveNote();
    state.activeMode = mode;
    state.activeNoteId = id;

    if (mode === "public") {
      state.prefs.lastPublicNoteId = id;
      persistPrefs();
    }

    renderAll();
    closeMobileSidebar();
  }

  function flushActiveNote() {
    const note = getActiveNote();
    if (!note || editorWrap.classList.contains("hidden")) return;

    note.title = noteTitle.value.trim();
    note.category = categoryInput.value.trim();
    note.tags = normalizeTags(tagsInput.value);
    note.content = editor.innerHTML;
    note.updatedAt = nowIso();

    persistCurrentMode();
    queueUpsert(note);
  }

  function scheduleSave() {
    saveState.textContent = "Saving…";
    saveState.classList.add("saving");

    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      flushActiveNote();
      saveState.textContent = "Saved";
      saveState.classList.remove("saving");
      updateWordCount();
      renderNoteList();
      updateCounts();
      updateStorageDisplay();
    }, 280);
  }

  function persistCurrentMode() {
    if (state.activeMode === "vault") {
      persistVault();
    } else {
      persistPublic();
    }
  }

  function deleteActiveNote() {
    const note = getActiveNote();
    if (!note) return;

    $("#confirmTitle").textContent = "Delete note?";
    $("#confirmText").textContent = `“${note.title || "Untitled"}” will be permanently removed.`;

    confirmDialog.showModal();

    const handler = () => {
      confirmDialog.removeEventListener("close", handler);
      if (confirmDialog.returnValue !== "confirm") return;

      const collection = getCurrentCollection();
      const index = collection.findIndex((item) => item.id === note.id);
      if (index >= 0) collection.splice(index, 1);

      persistCurrentMode();
      queueDelete(note.id);
      state.activeNoteId = null;

      const next = visibleNotes()[0];
      if (next) {
        state.activeMode = next.vault ? "vault" : "public";
        state.activeNoteId = next.id;
      }

      renderAll();
      showToast("Note deleted");
    };

    confirmDialog.addEventListener("close", handler);
  }

  function togglePin() {
    const note = getActiveNote();
    if (!note) return;
    note.pinned = !note.pinned;
    note.updatedAt = nowIso();
    persistCurrentMode();
    queueUpsert(note);
    renderAll();
    showToast(note.pinned ? "Pinned" : "Unpinned");
  }

  function moveActiveNoteAcrossVault() {
    const note = getActiveNote();
    if (!note) return;

    if (state.activeMode === "public") {
      if (!state.vaultUnlocked) {
        openVaultDialog("unlock", moveActiveNoteAcrossVault);
        return;
      }

      flushActiveNote();
      state.publicNotes = state.publicNotes.filter((item) => item.id !== note.id);
      note.vault = true;
      note.updatedAt = nowIso();
      state.vaultNotes.unshift(note);
      persistPublic();
      persistVault();
      state.activeMode = "vault";
      state.activeNoteId = note.id;
      state.filter = "vault";
      queueDelete(note.id);
      queueUpsert(note);
      syncFilterButtons();
      renderAll();
      showToast("Moved to private vault");
    } else {
      flushActiveNote();
      state.vaultNotes = state.vaultNotes.filter((item) => item.id !== note.id);
      note.vault = false;
      note.updatedAt = nowIso();
      state.publicNotes.unshift(note);
      persistVault();
      persistPublic();
      state.activeMode = "public";
      state.activeNoteId = note.id;
      state.filter = "all";
      queueDelete(note.id);
      queueUpsert(note);
      syncFilterButtons();
      renderAll();
      showToast("Moved to public notes");
    }
  }

  // ---------- Filtering / Rendering ----------
  function visibleNotes() {
    const query = state.query.trim().toLowerCase();
    let notes = [];

    if (state.filter === "vault") {
      notes = state.vaultUnlocked ? [...state.vaultNotes] : [];
    } else {
      notes = [...state.publicNotes];

      if (state.filter === "pinned") {
        if (state.vaultUnlocked) notes = notes.concat(state.vaultNotes);
        notes = notes.filter((note) => note.pinned);
      }
    }

    if (query) {
      notes = notes.filter((note) => {
        const haystack = [
          note.title,
          stripHtml(note.content),
          note.category,
          ...(note.tags || [])
        ].join(" ").toLowerCase();

        return haystack.includes(query);
      });
    }

    return notes.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }

  function renderNoteList() {
    const notes = visibleNotes();
    noteList.replaceChildren();

    if (state.filter === "vault" && !state.vaultUnlocked) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.innerHTML = `
        <strong>Vault locked</strong><br>
        Unlock the private vault to see encrypted notes.
      `;
      empty.addEventListener("click", () => openVaultDialog("unlock"));
      noteList.append(empty);
      noteListStatus.textContent = "Locked";
      refreshIcons();
      return;
    }

    noteListStatus.textContent = `${notes.length}`;

    if (!notes.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = state.query ? "No notes match your search." : "No notes here yet.";
      noteList.append(empty);
      return;
    }

    for (const note of notes) {
      const mode = note.vault ? "vault" : "public";
      const card = document.createElement("button");
      card.className = `note-card ${note.vault ? "vault-card" : ""} ${
        note.id === state.activeNoteId && mode === state.activeMode ? "active" : ""
      }`;

      const preview = stripHtml(note.content) || "No additional text";
      const category = note.category || (note.vault ? "Private" : "Notes");

      card.innerHTML = `
        <div class="note-card-main">
          <div class="note-card-title">${escapeHtml(note.title || "Untitled")}</div>
          <div class="note-card-preview">${escapeHtml(preview)}</div>
          <div class="note-card-meta">
            <span>${escapeHtml(formatDate(note.updatedAt))}</span>
            <span class="dot"></span>
            <span>${escapeHtml(category)}</span>
          </div>
        </div>
        <div class="note-card-icon">
          ${
            note.pinned
              ? '<i data-lucide="pin"></i>'
              : note.vault
              ? '<i data-lucide="lock-keyhole"></i>'
              : ""
          }
        </div>
      `;

      card.addEventListener("click", () => selectNote(note.id, mode));
      noteList.append(card);
    }

    refreshIcons();
  }

  function renderEditor() {
    const note = getActiveNote();

    if (!note) {
      editorWrap.classList.add("hidden");
      emptyState.classList.remove("hidden");
      return;
    }

    emptyState.classList.add("hidden");
    editorWrap.classList.remove("hidden");

    noteTitle.value = note.title || "";
    categoryInput.value = note.category || "";
    tagsInput.value = (note.tags || []).join(", ");
    editor.innerHTML = note.content || "";

    $("#pinBtn").classList.toggle("active", note.pinned);

    if (state.activeMode === "vault") {
      privacyBadge.classList.add("vault");
      privacyBadge.innerHTML = '<i data-lucide="lock-keyhole"></i> Private vault';
      $("#moveVaultBtn").title = "Move to public notes";
      $("#moveVaultBtn").innerHTML = '<i data-lucide="unlock"></i>';
    } else {
      privacyBadge.classList.remove("vault");
      privacyBadge.innerHTML = '<i data-lucide="globe-2"></i> Public note';
      $("#moveVaultBtn").title = "Move to private vault";
      $("#moveVaultBtn").innerHTML = '<i data-lucide="shield"></i>';
    }

    updatedAt.textContent = `Edited ${formatDate(note.updatedAt)}`;
    updateWordCount();
    refreshIcons();
  }

  function renderMode() {
    const vaultMode = state.activeMode === "vault";
    modePill.textContent = vaultMode ? "Vault" : "Public";
    modePill.classList.toggle("vault", vaultMode);
    $("#lockBtn").style.opacity = state.vaultUnlocked ? "1" : "0.45";
  }

  function updateCounts() {
    $("#allCount").textContent = state.publicNotes.length;
    const pinnedCount = state.publicNotes.filter((n) => n.pinned).length +
      (state.vaultUnlocked ? state.vaultNotes.filter((n) => n.pinned).length : 0);
    $("#pinnedCount").textContent = pinnedCount;
    $("#vaultCount").textContent = state.vaultUnlocked ? state.vaultNotes.length : "—";
  }

  function updateWordCount() {
    const text = stripHtml(editor.innerHTML);
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    wordCount.textContent = `${words} word${words === 1 ? "" : "s"}`;
  }

  function renderAll() {
    renderMode();
    renderNoteList();
    renderEditor();
    updateCounts();
    updateStorageDisplay();
    refreshIcons();
  }

  function syncFilterButtons() {
    $$(".filter-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.filter === state.filter);
    });
  }

  // ---------- Vault ----------
  let vaultSuccessCallback = null;
  let vaultDialogMode = "unlock";

  function openVaultDialog(mode = "unlock", onSuccess = null) {
    vaultDialogMode = mode;
    vaultSuccessCallback = onSuccess;
    vaultError.textContent = "";
    vaultPasscodeInput.value = "";
    vaultConfirmInput.value = "";

    if (!vaultExists()) {
      mode = "setup";
      vaultDialogMode = "setup";
    }

    if (mode === "setup") {
      vaultDialogTitle.textContent = "Create Private Vault";
      vaultDialogText.textContent =
        "Choose a passcode. If you forget it, encrypted vault notes cannot be recovered.";
      vaultConfirmWrap.classList.remove("hidden");
      vaultConfirmInput.required = true;
      vaultSubmitBtn.textContent = "Create vault";
      vaultPasscodeInput.autocomplete = "new-password";
    } else if (mode === "change") {
      vaultDialogTitle.textContent = "Set New Vault Passcode";
      vaultDialogText.textContent =
        "Enter a new passcode. Your unlocked vault notes will be re-encrypted with it.";
      vaultConfirmWrap.classList.remove("hidden");
      vaultConfirmInput.required = true;
      vaultSubmitBtn.textContent = "Change passcode";
      vaultPasscodeInput.autocomplete = "new-password";
    } else {
      vaultDialogTitle.textContent = "Unlock Private Vault";
      vaultDialogText.textContent = "Enter your private vault passcode.";
      vaultConfirmWrap.classList.add("hidden");
      vaultConfirmInput.required = false;
      vaultSubmitBtn.textContent = "Unlock";
      vaultPasscodeInput.autocomplete = "current-password";
    }

    vaultDialog.showModal();
    setTimeout(() => vaultPasscodeInput.focus(), 50);
  }

  vaultForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const passcode = vaultPasscodeInput.value;
    const confirm = vaultConfirmInput.value;

    if (passcode.length < 4) {
      vaultError.textContent = "Use at least 4 characters.";
      return;
    }

    try {
      if (vaultDialogMode === "setup") {
        if (passcode !== confirm) {
          vaultError.textContent = "Passcodes do not match.";
          return;
        }

        localStorage.setItem(KEYS.vaultHash, sha256(passcode));
        state.vaultPasscode = passcode;
        state.vaultUnlocked = true;
        state.vaultNotes = [];
        persistVault();
      } else if (vaultDialogMode === "change") {
        if (!state.vaultUnlocked) {
          vaultError.textContent = "Unlock the vault before changing its passcode.";
          return;
        }

        if (passcode !== confirm) {
          vaultError.textContent = "Passcodes do not match.";
          return;
        }

        localStorage.setItem(KEYS.vaultHash, sha256(passcode));
        state.vaultPasscode = passcode;
        persistVault();
        state.vaultNotes.forEach(queueUpsert);
      } else {
        const localHash = localStorage.getItem(KEYS.vaultHash);
        if (localHash && !verifyVaultPasscode(passcode)) {
          vaultError.textContent = "Incorrect passcode.";
          return;
        }
        const cloudNotes = state.cloudVaultRows.map((row) => decryptObject(row.encrypted_payload, passcode));
        const cipher = localStorage.getItem(KEYS.vault);
        const localNotes = cipher ? decryptObject(cipher, passcode) : [];
        state.vaultNotes = [...cloudNotes, ...localNotes.filter((note) => !cloudNotes.some((cloudNote) => cloudNote.id === note.id))];
        if (!localHash) localStorage.setItem(KEYS.vaultHash, sha256(passcode));
        state.vaultPasscode = passcode;
        state.vaultUnlocked = true;
        persistVault();
      }

      vaultDialog.close();
      renderAll();
      showToast(vaultDialogMode === "change" ? "Vault passcode changed" : "Vault unlocked");

      const callback = vaultSuccessCallback;
      vaultSuccessCallback = null;
      if (callback) callback();
    } catch (error) {
      console.error(error);
      vaultError.textContent = "Vault data could not be decrypted.";
    }
  });

  function lockVault() {
    if (!state.vaultUnlocked) {
      showToast("Vault is already locked");
      return;
    }

    if (state.activeMode === "vault") {
      flushActiveNote();
    }

    state.vaultUnlocked = false;
    state.vaultPasscode = "";
    state.vaultNotes = [];

    if (state.activeMode === "vault") {
      state.activeMode = "public";
      state.filter = "all";
      state.activeNoteId =
        state.publicNotes.find((n) => n.id === state.prefs.lastPublicNoteId)?.id ||
        state.publicNotes[0]?.id ||
        null;
      syncFilterButtons();
    }

    renderAll();
    showToast("Private vault locked");
  }

  // ---------- Editor formatting ----------
  function focusEditor() {
    editor.focus();
  }

  function exec(command, value = null) {
    focusEditor();
    document.execCommand(command, false, value);
    scheduleSave();
  }

  $("#formatToolbar").addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });

  $$("[data-command]").forEach((button) => {
    button.addEventListener("click", () => exec(button.dataset.command));
  });

  $$("[data-block]").forEach((button) => {
    button.addEventListener("click", () => exec("formatBlock", button.dataset.block));
  });

  $("#clearFormatBtn").addEventListener("click", () => {
    exec("removeFormat");
    exec("formatBlock", "p");
  });

  $("#codeBlockBtn").addEventListener("click", () => {
    focusEditor();
    const selection = window.getSelection();
    const selected = selection ? selection.toString() : "";
    const html = `<pre>${escapeHtml(selected || "code")}</pre><p><br></p>`;
    document.execCommand("insertHTML", false, html);
    scheduleSave();
  });

  $("#checklistBtn").addEventListener("click", () => {
    focusEditor();
    const html = `
      <div class="checklist-row" contenteditable="false">
        <input type="checkbox" />
        <span class="checklist-text" contenteditable="true">Checklist item</span>
      </div>
      <p><br></p>
    `;
    document.execCommand("insertHTML", false, html);
    scheduleSave();
  });

  // Make checklist checkbox state persist into editor HTML.
  editor.addEventListener("change", (event) => {
    if (event.target.matches('input[type="checkbox"]')) {
      if (event.target.checked) {
        event.target.setAttribute("checked", "");
      } else {
        event.target.removeAttribute("checked");
      }
      scheduleSave();
    }
  });

  // ---------- Search / filters ----------
  searchInput.addEventListener("input", () => {
    const raw = searchInput.value;

    if (raw.trim() === state.prefs.vaultTrigger) {
      searchInput.value = "";
      state.query = "";
      openVaultDialog("unlock", () => {
        state.filter = "vault";
        state.activeMode = "vault";
        state.activeNoteId = state.vaultNotes[0]?.id || null;
        syncFilterButtons();
        renderAll();
      });
      return;
    }

    state.query = raw;
    renderNoteList();
  });

  $$(".filter-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;
      closeMobileSidebar();

      if (filter === "vault" && !state.vaultUnlocked) {
        openVaultDialog("unlock", () => {
          state.filter = "vault";
          state.activeMode = "vault";
          state.activeNoteId = state.vaultNotes[0]?.id || null;
          syncFilterButtons();
          renderAll();
        });
        return;
      }

      flushActiveNote();
      state.filter = filter;

      if (filter === "vault") {
        state.activeMode = "vault";
        if (!state.vaultNotes.some((n) => n.id === state.activeNoteId)) {
          state.activeNoteId = state.vaultNotes[0]?.id || null;
        }
      } else if (filter === "all" && state.activeMode === "vault") {
        state.activeMode = "public";
        state.activeNoteId = state.publicNotes[0]?.id || null;
      }

      syncFilterButtons();
      renderAll();
    });
  });

  // ---------- Import / export ----------
  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    flushActiveNote();

    const payload = {
      app: "Mac Notes",
      version: 1,
      exportedAt: nowIso(),
      publicNotes: state.publicNotes,
      vaultCiphertext: localStorage.getItem(KEYS.vault) || "",
      vaultHash: localStorage.getItem(KEYS.vaultHash) || "",
      preferences: state.prefs
    };

    downloadFile(
      `mac-notes-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );

    showToast("JSON backup exported");
  }

  function exportTxt() {
    flushActiveNote();

    const sections = [];

    const appendNote = (note, label) => {
      sections.push(
        `${label}: ${note.title || "Untitled"}\n` +
        `Category: ${note.category || "—"}\n` +
        `Tags: ${(note.tags || []).join(", ") || "—"}\n` +
        `Updated: ${note.updatedAt}\n\n` +
        `${stripHtml(note.content)}\n\n` +
        `${"-".repeat(60)}\n`
      );
    };

    state.publicNotes.forEach((note) => appendNote(note, "PUBLIC"));
    if (state.vaultUnlocked) {
      state.vaultNotes.forEach((note) => appendNote(note, "PRIVATE"));
    }

    downloadFile(
      `mac-notes-${new Date().toISOString().slice(0, 10)}.txt`,
      sections.join("\n"),
      "text/plain;charset=utf-8"
    );

    showToast(state.vaultUnlocked ? "TXT exported" : "TXT exported (vault omitted because locked)");
  }

  function importJson(file) {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);

        if (!data || !Array.isArray(data.publicNotes)) {
          throw new Error("Invalid backup format");
        }

        state.publicNotes = data.publicNotes;
        state.prefs = { ...DEFAULT_PREFS, ...(data.preferences || {}) };

        localStorage.setItem(KEYS.publicNotes, JSON.stringify(state.publicNotes));
        localStorage.setItem(KEYS.preferences, JSON.stringify(state.prefs));

        if (typeof data.vaultCiphertext === "string") {
          if (data.vaultCiphertext) localStorage.setItem(KEYS.vault, data.vaultCiphertext);
          else localStorage.removeItem(KEYS.vault);
        }

        if (typeof data.vaultHash === "string") {
          if (data.vaultHash) localStorage.setItem(KEYS.vaultHash, data.vaultHash);
          else localStorage.removeItem(KEYS.vaultHash);
        }

        state.vaultUnlocked = false;
        state.vaultPasscode = "";
        state.vaultNotes = [];
        state.activeMode = "public";
        state.filter = "all";
        state.activeNoteId = state.publicNotes[0]?.id || null;
        searchInput.value = "";
        state.query = "";
        syncFilterButtons();
        renderAll();
        showToast("Backup imported");
      } catch (error) {
        console.error(error);
        showToast("Could not import that backup");
      }
    };

    reader.readAsText(file);
  }

  // ---------- Settings ----------
  function openSettings() {
    $("#vaultTriggerInput").value = state.prefs.vaultTrigger;
    $("#unlockVaultSettingsBtn").textContent = state.vaultUnlocked ? "Vault unlocked" : "Unlock vault";
    $("#unlockVaultSettingsBtn").disabled = state.vaultUnlocked;
    updateStorageDisplay();
    settingsDialog.showModal();
    refreshIcons();
  }

  $("#saveTriggerBtn").addEventListener("click", () => {
    const value = $("#vaultTriggerInput").value.trim();
    if (!value) {
      showToast("Trigger cannot be empty");
      return;
    }
    state.prefs.vaultTrigger = value;
    persistPrefs();
    showToast("Secret trigger saved");
  });

  $("#unlockVaultSettingsBtn").addEventListener("click", () => openVaultDialog("unlock"));

  $("#changeVaultPassBtn").addEventListener("click", () => {
    if (!state.vaultUnlocked) {
      openVaultDialog("unlock", () => openVaultDialog("change"));
      return;
    }
    openVaultDialog("change");
  });

  $("#clearAllBtn").addEventListener("click", () => {
    $("#confirmTitle").textContent = "Erase all local data?";
    $("#confirmText").textContent =
      "All public notes, encrypted vault data, passcode data, and preferences will be removed from this browser.";

    confirmDialog.showModal();

    const handler = () => {
      confirmDialog.removeEventListener("close", handler);
      if (confirmDialog.returnValue !== "confirm") return;

      Object.values(KEYS).forEach((key) => localStorage.removeItem(key));
      state.publicNotes = [];
      state.vaultNotes = [];
      state.vaultUnlocked = false;
      state.vaultPasscode = "";
      state.activeNoteId = null;
      state.activeMode = "public";
      state.filter = "all";
      state.query = "";
      state.prefs = { ...DEFAULT_PREFS };
      settingsDialog.close();
      loadStorage();
      state.activeNoteId = state.publicNotes[0]?.id || null;
      syncFilterButtons();
      renderAll();
      showToast("Local data erased");
    };

    confirmDialog.addEventListener("close", handler);
  });

  // ---------- Account / connectivity ----------
  let authMode = "signin";
  function openAuthDialog() {
    if (!state.supabase) { showToast("Add supabase-config.js to enable sync"); return; }
    if (state.user) { signOut(); return; }
    authMode = "signin"; $("#authForm").reset(); $("#authError").textContent = "";
    $("#authDialogTitle").textContent = "Sync your notes";
    $("#authDialogText").textContent = "Sign in to securely sync notes across your devices.";
    $("#authModeBtn").textContent = "Create account"; $("#authSubmitBtn").textContent = "Sign in";
    $("#authDialog").showModal(); refreshIcons();
  }
  $("#authModeBtn").addEventListener("click", () => {
    authMode = authMode === "signin" ? "signup" : "signin";
    $("#authDialogTitle").textContent = authMode === "signup" ? "Create your account" : "Sync your notes";
    $("#authDialogText").textContent = authMode === "signup" ? "Use an email and password to keep your notes available on your devices." : "Sign in to securely sync notes across your devices.";
    $("#authModeBtn").textContent = authMode === "signup" ? "I already have an account" : "Create account";
    $("#authSubmitBtn").textContent = authMode === "signup" ? "Create account" : "Sign in";
    $("#authPassword").autocomplete = authMode === "signup" ? "new-password" : "current-password";
  });
  $("#authForm").addEventListener("submit", async (event) => {
    event.preventDefault(); const email = $("#authEmail").value.trim(); const password = $("#authPassword").value;
    const action = authMode === "signup" ? state.supabase.auth.signUp({ email, password }) : state.supabase.auth.signInWithPassword({ email, password });
    $("#authSubmitBtn").disabled = true; const { data, error } = await action; $("#authSubmitBtn").disabled = false;
    if (error) { $("#authError").textContent = error.message; return; }
    if (authMode === "signup" && !data.session) { $("#authError").textContent = "Check your email to confirm your account, then sign in."; return; }
    $("#authDialog").close();
  });
  async function signOut() {
    flushActiveNote(); await state.supabase.auth.signOut(); state.user = null; state.handledUserId = null; state.pending = []; updateAccountUi(); showToast("Signed out; local cache remains on this device");
  }
  accountBtn.addEventListener("click", openAuthDialog);
  $("#migrationSkipBtn").addEventListener("click", async () => { $("#migrationDialog").close(); markMigrated(); await loadCloudNotes(); });
  $("#migrationStartBtn").addEventListener("click", async () => { $("#migrationDialog").close(); await migrateLocalNotes(); });
  window.addEventListener("online", () => { if (state.user) { loadCloudNotes().then(syncPending); } });
  window.addEventListener("offline", () => { if (state.user) setSyncStatus("offline"); });

  // ---------- Events ----------
  $("#newNoteBtn").addEventListener("click", () => createNewNote());
  $("#emptyNewNoteBtn").addEventListener("click", () => createNewNote());
  $("#deleteBtn").addEventListener("click", deleteActiveNote);
  $("#pinBtn").addEventListener("click", togglePin);
  $("#moveVaultBtn").addEventListener("click", moveActiveNoteAcrossVault);
  $("#lockBtn").addEventListener("click", lockVault);
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#closeSettingsBtn").addEventListener("click", () => settingsDialog.close());

  $("#quickExportBtn").addEventListener("click", exportJson);
  $("#exportJsonBtn").addEventListener("click", exportJson);
  $("#exportTxtBtn").addEventListener("click", exportTxt);
  $("#importBtn").addEventListener("click", () => $("#importFileInput").click());

  $("#importFileInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importJson(file);
    event.target.value = "";
  });

  [noteTitle, categoryInput, tagsInput].forEach((input) => {
    input.addEventListener("input", scheduleSave);
  });

  editor.addEventListener("input", scheduleSave);

  mobileMenuBtn.addEventListener("click", () => {
    setMobileSidebar(!appShell.classList.contains("sidebar-open"));
  });
  sidebarBackdrop.addEventListener("click", closeMobileSidebar);
  mobileSidebarQuery.addEventListener("change", () => {
    if (!isMobileSidebar()) {
      appShell.classList.remove("sidebar-open");
      sidebarBackdrop.classList.remove("is-open");
      mobileMenuBtn.setAttribute("aria-expanded", "false");
      mobileMenuBtn.setAttribute("aria-label", "Open notes sidebar");
    }
  });

  // Save before leaving/reloading.
  window.addEventListener("beforeunload", flushActiveNote);

  // Keyboard shortcuts.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && appShell.classList.contains("sidebar-open")) {
      closeMobileSidebar();
      mobileMenuBtn.focus();
      return;
    }

    if (!(event.ctrlKey || event.metaKey)) return;

    const key = event.key.toLowerCase();

    if (key === "n") {
      event.preventDefault();
      createNewNote();
    } else if (key === "s") {
      event.preventDefault();
      clearTimeout(state.saveTimer);
      flushActiveNote();
      saveState.textContent = "Saved";
      saveState.classList.remove("saving");
      renderNoteList();
      updateCounts();
      updateStorageDisplay();
      showToast("Saved");
    } else if (key === "f") {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (key === "l") {
      event.preventDefault();
      lockVault();
    }
  });

  // ---------- Start ----------
  function init() {
    loadStorage();

    state.activeMode = "public";
    state.activeNoteId =
      state.publicNotes.find((n) => n.id === state.prefs.lastPublicNoteId)?.id ||
      state.publicNotes[0]?.id ||
      null;

    syncFilterButtons();
    renderAll();
    initCloud();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
