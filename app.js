(() => {
  "use strict";

  // ---------- Config ----------
  const SCOPES = "user-read-currently-playing user-modify-playback-state playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative";
  const PAD_COLORS = ["#FF6B6B", "#4ECDC4", "#FFD93D", "#A78BFA", "#6BCB77", "#FF8FAB", "#5EA8ED", "#F4977C"];
  const POLL_MS = 5000;
  const PAUSE_GRACE_MS = 60000;

  const LS = {
    clientId: "pp_client_id",
    playlists: "pp_playlists",
    access: "pp_access_token",
    refresh: "pp_refresh_token",
    expires: "pp_expires_at",
    verifier: "pp_code_verifier",
    state: "pp_oauth_state",
    removeOnAssign: "pp_remove_on_assign",
  };

  const ICON_PLAY = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
  const ICON_PAUSE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';

  // ---------- DOM ----------
  const el = (id) => document.getElementById(id);
  const artImg = el("art");
  const artPlaceholder = el("art-placeholder");
  const npStatus = el("np-status");
  const npTitle = el("np-title");
  const npArtist = el("np-artist");
  const npDot = el("np-dot");
  const connectScreen = el("connect-screen");
  const emptyScreen = el("empty-screen");
  const padGrid = el("pad-grid");
  const toastEl = el("toast");

  const settingsOverlay = el("settings-overlay");
  const inputClientId = el("input-client-id");
  const inputRedirectUri = el("input-redirect-uri");
  const playlistRows = el("playlist-rows");
  const toggleRemoveOnAssign = el("toggle-remove-on-assign");

  const pickerOverlay = el("picker-overlay");
  const pickerStatus = el("picker-status");
  const pickerList = el("picker-list");

  const bulkOverlay = el("bulk-overlay");
  const inputBulkSource = el("input-bulk-source");
  const btnBulkLoadJson = el("btn-bulk-load-json");
  const bulkSummary = el("bulk-summary");
  const bulkProgress = el("bulk-progress");
  const bulkProgressText = el("bulk-progress-text");
  const bulkProgressFill = el("bulk-progress-fill");
  const bulkResult = el("bulk-result");
  const btnBulkConfirm = el("btn-bulk-confirm");

  const btnPrev = el("btn-prev");
  const btnPlayPause = el("btn-playpause");
  const btnNext = el("btn-next");
  const btnRemoveCurrent = el("btn-remove-current");

  let currentTrackUri = null;
  let currentIsPlaying = false;
  let currentPlaylistContextId = null;
  let lastReportedAt = 0;
  let pollTimer = null;
  const playlistTrackCache = {};

  let bulkPlan = []; // [{ uri, trackName, targetId, targetName }]
  let bulkNotFound = {}; // targetName -> count (named in JSON but no matching configured playlist)
  let bulkSourceId = "";
  let bulkRunning = false;

  // ---------- Helpers ----------
  function getRedirectUri() {
    // Must match EXACTLY what you register in the Spotify dashboard —
    // whatever URL this page is actually loaded from.
    return window.location.origin + window.location.pathname;
  }

  function randomString(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => chars[b % chars.length]).join("");
  }

  async function sha256(plain) {
    const data = new TextEncoder().encode(plain);
    return crypto.subtle.digest("SHA-256", data);
  }

  function base64UrlEncode(buffer) {
    let str = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function extractPlaylistId(input) {
    if (!input) return "";
    const trimmed = input.trim();
    const m = trimmed.match(/playlist[/:]([a-zA-Z0-9]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9]{15,30}$/.test(trimmed)) return trimmed;
    return trimmed;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Waits (seconds + 1s buffer), calling onTick(secondsRemaining) roughly
  // once per second so the caller can keep a progress UI from looking stuck.
  async function waitForRetryAfter(seconds, onTick) {
    let remainingMs = Math.max(0, (seconds + 1) * 1000);
    while (remainingMs > 0) {
      onTick(Math.ceil(remainingMs / 1000));
      const step = Math.min(1000, remainingMs);
      await sleep(step);
      remainingMs -= step;
    }
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function loadPlaylists() {
    try { return JSON.parse(localStorage.getItem(LS.playlists)) || []; }
    catch { return []; }
  }
  function savePlaylists(arr) { localStorage.setItem(LS.playlists, JSON.stringify(arr)); }
  function loadClientId() { return localStorage.getItem(LS.clientId) || ""; }
  function saveClientId(v) { localStorage.setItem(LS.clientId, v); }

  function loadRemoveOnAssign() {
    const v = localStorage.getItem(LS.removeOnAssign);
    return v === null ? true : v === "true";
  }
  function saveRemoveOnAssign(v) { localStorage.setItem(LS.removeOnAssign, v ? "true" : "false"); }

  function isLoggedIn() {
    return !!localStorage.getItem(LS.refresh);
  }

  function clearTokens() {
    localStorage.removeItem(LS.access);
    localStorage.removeItem(LS.refresh);
    localStorage.removeItem(LS.expires);
  }

  // ---------- Auth: PKCE ----------
  async function login() {
    const clientId = loadClientId();
    if (!clientId) {
      showToast("Primero pon tu Client ID en Ajustes");
      openSettings();
      return;
    }
    const verifier = randomString(64);
    const challenge = base64UrlEncode(await sha256(verifier));
    const state = randomString(16);
    localStorage.setItem(LS.verifier, verifier);
    localStorage.setItem(LS.state, state);

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: getRedirectUri(),
      scope: SCOPES,
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
    });
    window.location.assign("https://accounts.spotify.com/authorize?" + params.toString());
  }

  async function handleRedirectIfNeeded() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const err = params.get("error");

    if (err) {
      showToast("Spotify dijo: " + err);
      history.replaceState({}, "", window.location.pathname);
      return;
    }
    if (!code) return;

    const savedState = localStorage.getItem(LS.state);
    const verifier = localStorage.getItem(LS.verifier);
    history.replaceState({}, "", window.location.pathname);

    if (!verifier || state !== savedState) {
      showToast("No se pudo validar el inicio de sesión, intenta de nuevo");
      return;
    }

    const clientId = loadClientId();
    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: getRedirectUri(),
          client_id: clientId,
          code_verifier: verifier,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.error || "token error");
      saveTokens(data);
      showToast("¡Conectado!");
    } catch (e) {
      showToast("Error al conectar: " + e.message);
    }
  }

  function saveTokens(data) {
    localStorage.setItem(LS.access, data.access_token);
    if (data.refresh_token) localStorage.setItem(LS.refresh, data.refresh_token);
    localStorage.setItem(LS.expires, String(Date.now() + data.expires_in * 1000));
  }

  async function refreshAccessToken() {
    const clientId = loadClientId();
    const refresh = localStorage.getItem(LS.refresh);
    if (!clientId || !refresh) return null;
    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refresh,
          client_id: clientId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "refresh failed");
      saveTokens(data);
      return data.access_token;
    } catch (e) {
      clearTokens();
      return null;
    }
  }

  async function ensureFreshToken() {
    if (!isLoggedIn()) return null;
    const expiresAt = Number(localStorage.getItem(LS.expires) || 0);
    if (Date.now() > expiresAt - 30000) {
      return await refreshAccessToken();
    }
    return localStorage.getItem(LS.access);
  }

  function logout() {
    clearTokens();
    updateAuthUI();
    showToast("Sesión cerrada");
  }

  // ---------- Currently playing ----------
  async function pollCurrentlyPlaying() {
    const token = await ensureFreshToken();
    if (!token) { updateAuthUI(); return; }

    try {
      const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
        headers: { Authorization: "Bearer " + token },
      });

      if (res.status === 204) {
        handleNothingReported();
        return;
      }
      if (res.status === 401) {
        const fresh = await refreshAccessToken();
        if (!fresh) updateAuthUI();
        return;
      }
      if (!res.ok) return;

      const data = await res.json();
      if (!data || !data.item) { handleNothingReported(); return; }
      lastReportedAt = Date.now();
      setNowPlaying(data.item, data.is_playing, data.context);
    } catch {
      // network hiccup, try again next tick
    }
  }

  // Spotify stops reporting a track shortly after it's paused. Rather than
  // wiping the "now playing" panel the instant that happens, keep showing
  // the last known track as paused for a grace window so the UI doesn't
  // flicker to empty every time the user pauses.
  function handleNothingReported() {
    if (currentTrackUri && Date.now() - lastReportedAt < PAUSE_GRACE_MS) {
      currentIsPlaying = false;
      updateStatusDisplay();
      updateControlButtons();
      return;
    }
    setNowPlaying(null);
  }

  function updateStatusDisplay() {
    if (!currentTrackUri) {
      npStatus.textContent = "NADA SONANDO";
      npDot.classList.remove("live");
      return;
    }
    npStatus.textContent = currentIsPlaying ? "REPRODUCIENDO" : "EN PAUSA";
    npDot.classList.toggle("live", currentIsPlaying);
  }

  function setNowPlaying(item, isPlaying, context) {
    if (!item) {
      currentTrackUri = null;
      currentIsPlaying = false;
      currentPlaylistContextId = null;
      updateStatusDisplay();
      npTitle.textContent = "—";
      npArtist.textContent = "";
      artImg.classList.remove("has-art");
      setPadsEnabled(false);
      updateControlButtons();
      updatePadIndicators();
      return;
    }
    currentTrackUri = item.uri;
    currentIsPlaying = !!isPlaying;
    currentPlaylistContextId = null;
    if (context && context.type === "playlist" && context.uri) {
      const m = context.uri.match(/playlist:([a-zA-Z0-9]+)/);
      if (m) currentPlaylistContextId = m[1];
    }
    updateStatusDisplay();
    npTitle.textContent = item.name || "—";
    npArtist.textContent = (item.artists || []).map((a) => a.name).join(", ");
    const img = item.album && item.album.images && item.album.images[item.album.images.length - 1];
    if (img) {
      artImg.src = img.url;
      artImg.classList.add("has-art");
    } else {
      artImg.classList.remove("has-art");
    }
    setPadsEnabled(true);
    updateControlButtons();
    updatePadIndicators();
  }

  function updateControlButtons() {
    const hasTrack = !!currentTrackUri;
    btnPrev.disabled = !hasTrack;
    btnPlayPause.disabled = !hasTrack;
    btnPlayPause.innerHTML = currentIsPlaying ? ICON_PAUSE : ICON_PLAY;
    btnNext.disabled = !hasTrack;
    btnRemoveCurrent.disabled = !hasTrack || !currentPlaylistContextId;
  }

  async function togglePlayPause() {
    const token = await ensureFreshToken();
    if (!token) { showToast("Conecta tu cuenta de Spotify"); return; }
    const endpoint = currentIsPlaying ? "pause" : "play";
    try {
      const res = await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token },
      });
      if (res.status === 404) { showToast("No hay ningún dispositivo activo"); return; }
      if (!res.ok && res.status !== 204) { showToast("No se pudo " + (currentIsPlaying ? "pausar" : "reproducir")); return; }
      currentIsPlaying = !currentIsPlaying;
      updateStatusDisplay();
      updateControlButtons();
      setTimeout(pollCurrentlyPlaying, 400);
    } catch {
      showToast("Error de red");
    }
  }

  async function skipNext() {
    const token = await ensureFreshToken();
    if (!token) { showToast("Conecta tu cuenta de Spotify"); return; }
    try {
      const res = await fetch("https://api.spotify.com/v1/me/player/next", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
      if (res.status === 404) { showToast("No hay ningún dispositivo activo"); return; }
      if (!res.ok && res.status !== 204) { showToast("No se pudo saltar la canción"); return; }
      setTimeout(pollCurrentlyPlaying, 500);
    } catch {
      showToast("Error de red");
    }
  }

  async function skipPrevious() {
    const token = await ensureFreshToken();
    if (!token) { showToast("Conecta tu cuenta de Spotify"); return; }
    try {
      const res = await fetch("https://api.spotify.com/v1/me/player/previous", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
      if (res.status === 404) { showToast("No hay ningún dispositivo activo"); return; }
      if (!res.ok && res.status !== 204) { showToast("No se pudo regresar la canción"); return; }
      setTimeout(pollCurrentlyPlaying, 500);
    } catch {
      showToast("Error de red");
    }
  }

  async function deleteTrackFromPlaylist(playlistId, trackUri) {
    const token = await ensureFreshToken();
    if (!token) return { ok: false, reason: "auth" };
    try {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: [{ uri: trackUri }] }),
      });
      if (res.status === 403) return { ok: false, reason: "forbidden" };
      if (!res.ok) return { ok: false, reason: "error" };
      return { ok: true };
    } catch {
      return { ok: false, reason: "network" };
    }
  }

  async function removeCurrentFromPlaylist() {
    if (!currentTrackUri || !currentPlaylistContextId) return;
    const result = await deleteTrackFromPlaylist(currentPlaylistContextId, currentTrackUri);
    if (!result.ok) {
      if (result.reason === "auth") showToast("Conecta tu cuenta de Spotify");
      else if (result.reason === "forbidden") showToast("No puedes editar esta playlist");
      else if (result.reason === "network") showToast("Error de red al quitar la canción");
      else showToast("No se pudo quitar la canción");
      return;
    }
    if (playlistTrackCache[currentPlaylistContextId]) playlistTrackCache[currentPlaylistContextId].delete(currentTrackUri);
    showToast("Canción quitada — saltando a la siguiente");
    await skipNext();
  }

  function setPadsEnabled(enabled) {
    document.querySelectorAll(".pad").forEach((p) => p.classList.toggle("disabled", !enabled));
  }

  // ---------- Pads ----------
  function renderPads() {
    const playlists = loadPlaylists();
    padGrid.innerHTML = "";

    if (!isLoggedIn()) return;

    if (playlists.length === 0) {
      emptyScreen.classList.remove("hidden");
      padGrid.classList.add("hidden");
      return;
    }
    emptyScreen.classList.add("hidden");
    padGrid.classList.remove("hidden");

    playlists.forEach((pl, i) => {
      const btn = document.createElement("button");
      btn.className = "pad";
      btn.dataset.playlistId = pl.id;
      btn.style.background = PAD_COLORS[i % PAD_COLORS.length];
      btn.innerHTML = `<span>${escapeHtml(pl.name)}</span><span class="pad-check">✓</span><span class="pad-indicator"></span>`;
      btn.addEventListener("click", () => assignToPad(pl, btn));
      padGrid.appendChild(btn);
    });
    setPadsEnabled(!!currentTrackUri);
    updatePadIndicators();
    preloadAllPlaylistCaches();
  }

  // Marks pads whose playlist already contains the currently playing track.
  // Relies on playlistTrackCache, which preloadAllPlaylistCaches keeps warm
  // in the background so this never blocks the UI.
  function updatePadIndicators() {
    const uri = currentTrackUri;
    document.querySelectorAll(".pad").forEach((btn) => {
      const cache = playlistTrackCache[btn.dataset.playlistId];
      btn.classList.toggle("pad-added", !!(uri && cache && cache.has(uri)));
    });
  }

  async function preloadAllPlaylistCaches() {
    const playlists = loadPlaylists();
    await Promise.all(playlists.map((pl) => getPlaylistTrackUris(pl.id)));
    updatePadIndicators();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function getPlaylistTrackUris(playlistId) {
    if (playlistTrackCache[playlistId]) return playlistTrackCache[playlistId];

    const token = await ensureFreshToken();
    if (!token) return null;

    const uris = new Set();
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50`;

    try {
      while (url) {
        const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
        if (!res.ok) return null;
        const data = await res.json();
        (data.items || []).forEach((entry) => {
          const uri = (entry.item && entry.item.uri) || (entry.track && entry.track.uri);
          if (uri) uris.add(uri);
        });
        url = data.next || null;
      }
    } catch {
      return null;
    }

    playlistTrackCache[playlistId] = uris;
    return uris;
  }

  async function assignToPad(playlist, btnEl) {
    if (!currentTrackUri) {
      showToast("No hay ninguna canción sonando ahorita");
      return;
    }
    const trackUri = currentTrackUri;
    const contextId = currentPlaylistContextId;

    const token = await ensureFreshToken();
    if (!token) { showToast("Conecta tu cuenta de Spotify"); updateAuthUI(); return; }

    const existing = await getPlaylistTrackUris(playlist.id);
    if (existing && existing.has(trackUri)) {
      showToast(`Ya está en ${playlist.name}`);
      return;
    }

    try {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [trackUri] }),
      });

      if (res.status === 201) {
        if (playlistTrackCache[playlist.id]) playlistTrackCache[playlist.id].add(trackUri);
        btnEl.classList.remove("flash");
        void btnEl.offsetWidth;
        btnEl.classList.add("flash");
        showToast(`Agregada a ${playlist.name}`);

        if (loadRemoveOnAssign() && contextId && contextId !== playlist.id) {
          const removeResult = await deleteTrackFromPlaylist(contextId, trackUri);
          if (removeResult.ok && playlistTrackCache[contextId]) playlistTrackCache[contextId].delete(trackUri);
        }

        updatePadIndicators();
        return;
      }

      if (res.status === 401) {
        const fresh = await refreshAccessToken();
        if (fresh) return assignToPad(playlist, btnEl);
        updateAuthUI();
        return;
      }

      const data = await res.json().catch(() => ({}));
      showToast("Error: " + (data.error?.message || res.status));
    } catch (e) {
      showToast("Error de red al agregar la canción");
    }
  }

  // ---------- Fetch the user's own Spotify playlists (for the picker) ----------
  async function fetchMyProfileId() {
    const token = await ensureFreshToken();
    if (!token) return null;
    try {
      const res = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.id || null;
    } catch {
      return null;
    }
  }

  async function fetchMyPlaylists() {
    const token = await ensureFreshToken();
    if (!token) return { items: null, error: "not_logged_in" };

    const myId = await fetchMyProfileId();

    let raw = [];
    let url = "https://api.spotify.com/v1/me/playlists?limit=50";

    try {
      while (url) {
        const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
        if (!res.ok) return { items: null, error: "http_" + res.status };
        const data = await res.json();
        raw = raw.concat((data.items || []).filter(Boolean));
        url = data.next || null;
      }
      // Only playlists you can actually add tracks to: ones you own, or
      // collaborative ones — this also filters out the dozens of
      // Spotify-generated playlists (Discover Weekly, Daily Mix, etc.)
      // that GET /me/playlists includes just because you follow them.
      const items = raw
        .filter((p) => p.collaborative || (myId && p.owner && p.owner.id === myId))
        .map((p) => ({ id: p.id, name: p.name }));
      return { items, error: null };
    } catch {
      return { items: null, error: "network" };
    }
  }

  // ---------- Playlist picker ----------
  function currentRowIds() {
    return Array.from(playlistRows.querySelectorAll(".playlist-row .pl-link"))
      .map((input) => extractPlaylistId(input.value))
      .filter(Boolean);
  }

  async function openPicker() {
    pickerOverlay.classList.remove("hidden");
    pickerList.innerHTML = "";
    pickerStatus.textContent = "Cargando tus playlists…";

    const { items, error } = await fetchMyPlaylists();

    if (error) {
      pickerStatus.textContent =
        error === "not_logged_in"
          ? "Conecta tu cuenta primero."
          : "No se pudo cargar tu lista. Si acabas de actualizar la app, cierra sesión y vuelve a conectar (se agregó un permiso nuevo).";
      return;
    }
    if (!items.length) {
      pickerStatus.textContent = "No encontramos playlists propias o colaborativas en tu cuenta.";
      return;
    }

    pickerStatus.textContent = `${items.length} playlists encontradas — marca las que quieras usar:`;
    const existingIds = new Set(currentRowIds());

    items.forEach((pl) => {
      const already = existingIds.has(pl.id);
      const row = document.createElement("div");
      row.className = "picker-item" + (already ? " already" : "");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "pick-" + pl.id;
      checkbox.dataset.id = pl.id;
      checkbox.dataset.name = pl.name;
      if (already) { checkbox.checked = true; checkbox.disabled = true; }

      const label = document.createElement("label");
      label.setAttribute("for", checkbox.id);
      label.textContent = pl.name + (already ? " (ya agregada)" : "");

      row.append(checkbox, label);
      pickerList.appendChild(row);
    });
  }

  function closePicker() { pickerOverlay.classList.add("hidden"); }

  function confirmPicker() {
    const checked = Array.from(pickerList.querySelectorAll('input[type="checkbox"]:checked:not(:disabled)'));
    if (checked.length === 0) { closePicker(); return; }

    // Remove any fully-blank manual rows before appending real picks
    Array.from(playlistRows.querySelectorAll(".playlist-row")).forEach((row) => {
      const name = row.querySelector(".pl-name").value.trim();
      const link = row.querySelector(".pl-link").value.trim();
      if (!name && !link) row.remove();
    });

    checked.forEach((cb) => addPlaylistRow(cb.dataset.name, cb.dataset.id, playlistRows.children.length));
    closePicker();
    showToast(`${checked.length} playlist(s) agregada(s) — dale Guardar para confirmar`);
  }

  // ---------- Auth UI ----------
  function updateAuthUI() {
    if (isLoggedIn()) {
      connectScreen.classList.add("hidden");
      renderPads();
      startPolling();
    } else {
      connectScreen.classList.remove("hidden");
      emptyScreen.classList.add("hidden");
      padGrid.classList.add("hidden");
      padGrid.innerHTML = "";
      stopPolling();
      setNowPlaying(null);
      npStatus.textContent = "SIN CONEXIÓN";
    }
  }

  function startPolling() {
    stopPolling();
    pollCurrentlyPlaying();
    pollTimer = setInterval(pollCurrentlyPlaying, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling();
    else if (isLoggedIn()) startPolling();
  });

  // ---------- Settings sheet ----------
  function openSettings() {
    inputClientId.value = loadClientId();
    inputRedirectUri.value = getRedirectUri();
    renderPlaylistRows(loadPlaylists());
    toggleRemoveOnAssign.checked = loadRemoveOnAssign();
    settingsOverlay.classList.remove("hidden");
  }
  function closeSettings() { settingsOverlay.classList.add("hidden"); }

  function renderPlaylistRows(playlists) {
    playlistRows.innerHTML = "";
    playlists.forEach((pl, i) => addPlaylistRow(pl.name, pl.id, i));
    if (playlists.length === 0) addPlaylistRow("", "", 0);
  }

  function addPlaylistRow(name, idOrLink, index) {
    const row = document.createElement("div");
    row.className = "playlist-row";
    const swatchColor = PAD_COLORS[playlistRows.children.length % PAD_COLORS.length];

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = swatchColor;

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "pl-name";
    nameInput.placeholder = "Nombre (ej. Perreo)";
    nameInput.value = name || "";

    const linkInput = document.createElement("input");
    linkInput.type = "text";
    linkInput.className = "pl-link";
    linkInput.placeholder = "Link o ID de la playlist";
    linkInput.value = idOrLink || "";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove";
    removeBtn.setAttribute("aria-label", "Quitar");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => row.remove());

    row.append(swatch, nameInput, linkInput, removeBtn);
    playlistRows.appendChild(row);
  }

  function saveSettingsFromForm() {
    const clientId = inputClientId.value.trim();
    saveClientId(clientId);

    const rows = Array.from(playlistRows.querySelectorAll(".playlist-row"));
    const playlists = rows
      .map((row) => {
        const name = row.querySelector(".pl-name").value.trim();
        const link = row.querySelector(".pl-link").value.trim();
        const id = extractPlaylistId(link);
        return name && id ? { name, id } : null;
      })
      .filter(Boolean);

    savePlaylists(playlists);
    closeSettings();
    renderPads();
    showToast("Guardado");
  }

  // ---------- Bulk sort ----------
  // Reads clasificacion.json (spotify:track:uri -> exact playlist name) and,
  // for every track that's both in that file AND currently in the source
  // "Todo" playlist AND maps to one of the user's already-configured
  // playlists, moves it: POST to the target, then DELETE from the source.
  // Tracks missing from the file are never touched.

  async function fetchClassificationJson() {
    const res = await fetch("./clasificacion.json");
    if (!res.ok) throw new Error("No se pudo leer clasificacion.json (" + res.status + ")");
    return await res.json();
  }

  async function fetchPlaylistTracksDetailed(playlistId, attempt401 = 0) {
    const token = await ensureFreshToken();
    if (!token) return { ok: false, reason: "no se pudo autenticar — conecta tu cuenta de nuevo" };

    const map = new Map(); // uri -> "Track name — Artist"
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/items?limit=50`;

    try {
      while (url) {
        const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          console.error("[clasificación masiva] fallo al leer playlist", playlistId, "— status:", res.status, "body:", body);

          if (res.status === 401 && attempt401 < 1) {
            const fresh = await refreshAccessToken();
            if (fresh) return fetchPlaylistTracksDetailed(playlistId, attempt401 + 1);
          }

          const reason =
            res.status === 401 ? "tu sesión expiró, cierra sesión y vuelve a conectar" :
            res.status === 403 ? "no tienes permiso para leer esa playlist" :
            res.status === 404 ? "no se encontró esa playlist — revisa el link/ID" :
            (body.error && body.error.message) || `Spotify devolvió el error ${res.status}`;

          return { ok: false, reason };
        }

        const data = await res.json();
        (data.items || []).forEach((entry) => {
          const track = entry.item || entry.track;
          if (!track || !track.uri) return;
          const artists = (track.artists || []).map((a) => a.name).join(", ");
          map.set(track.uri, artists ? `${track.name} — ${artists}` : (track.name || track.uri));
        });
        url = data.next || null;
      }
    } catch (e) {
      console.error("[clasificación masiva] error de red al leer playlist", playlistId, e);
      return { ok: false, reason: "error de red al leer la playlist" };
    }
    return { ok: true, tracks: map };
  }

  async function bulkAddTrack(playlistId, trackUri, onWait = () => {}, attempt401 = 0, attempt429 = 0) {
    const token = await ensureFreshToken();
    if (!token) return { ok: false, reason: "no se pudo autenticar" };
    try {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [trackUri] }),
      });
      if (res.status === 201) return { ok: true };
      if (res.status === 401 && attempt401 < 1) {
        const fresh = await refreshAccessToken();
        if (fresh) return bulkAddTrack(playlistId, trackUri, onWait, attempt401 + 1, attempt429);
        return { ok: false, reason: "no se pudo autenticar" };
      }
      if (res.status === 429) {
        if (attempt429 < 5) {
          const retryAfter = Number(res.headers.get("Retry-After")) || 1;
          await waitForRetryAfter(retryAfter, onWait);
          return bulkAddTrack(playlistId, trackUri, onWait, attempt401, attempt429 + 1);
        }
        return { ok: false, reason: "Spotify limitó las solicitudes (429) tras varios reintentos" };
      }
      if (res.status === 403) return { ok: false, reason: "no tienes permiso sobre esa playlist" };
      const data = await res.json().catch(() => ({}));
      return { ok: false, reason: (data.error && data.error.message) || ("http " + res.status) };
    } catch {
      return { ok: false, reason: "error de red" };
    }
  }

  async function bulkDeleteTrack(playlistId, trackUri, onWait = () => {}, attempt401 = 0, attempt429 = 0) {
    const token = await ensureFreshToken();
    if (!token) return { ok: false, reason: "no se pudo autenticar" };
    try {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items: [{ uri: trackUri }] }),
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 && attempt401 < 1) {
        const fresh = await refreshAccessToken();
        if (fresh) return bulkDeleteTrack(playlistId, trackUri, onWait, attempt401 + 1, attempt429);
        return { ok: false, reason: "no se pudo autenticar" };
      }
      if (res.status === 429) {
        if (attempt429 < 5) {
          const retryAfter = Number(res.headers.get("Retry-After")) || 1;
          await waitForRetryAfter(retryAfter, onWait);
          return bulkDeleteTrack(playlistId, trackUri, onWait, attempt401, attempt429 + 1);
        }
        return { ok: false, reason: "Spotify limitó las solicitudes (429) tras varios reintentos" };
      }
      if (res.status === 403) return { ok: false, reason: "no tienes permiso sobre esa playlist" };
      const data = await res.json().catch(() => ({}));
      return { ok: false, reason: (data.error && data.error.message) || ("http " + res.status) };
    } catch {
      return { ok: false, reason: "error de red" };
    }
  }

  function openBulkSort() {
    inputBulkSource.value = "";
    bulkSummary.classList.add("hidden");
    bulkSummary.innerHTML = "";
    bulkResult.classList.add("hidden");
    bulkResult.innerHTML = "";
    bulkProgress.classList.add("hidden");
    btnBulkConfirm.classList.add("hidden");
    bulkPlan = [];
    bulkNotFound = {};
    bulkSourceId = "";
    bulkOverlay.classList.remove("hidden");
  }

  function closeBulkSort() {
    if (bulkRunning) { showToast("Espera a que termine de mover las canciones"); return; }
    bulkOverlay.classList.add("hidden");
  }

  async function handleBulkLoad() {
    if (bulkRunning) return;
    const sourceId = extractPlaylistId(inputBulkSource.value);
    if (!sourceId) { showToast('Pega el link o ID de tu playlist "Todo"'); return; }
    if (!isLoggedIn()) { showToast("Conecta tu cuenta de Spotify"); return; }

    const originalLabel = btnBulkLoadJson.textContent;
    btnBulkLoadJson.disabled = true;
    btnBulkLoadJson.textContent = "Cargando…";
    bulkSummary.classList.add("hidden");
    bulkResult.classList.add("hidden");
    bulkProgress.classList.add("hidden");
    btnBulkConfirm.classList.add("hidden");

    try {
      const [classification, todoResult] = await Promise.all([
        fetchClassificationJson(),
        fetchPlaylistTracksDetailed(sourceId),
      ]);

      if (!todoResult.ok) {
        showToast(`No se pudo leer la playlist "Todo": ${todoResult.reason}`);
        return;
      }
      const todoTracks = todoResult.tracks;

      const configured = loadPlaylists();
      const byName = new Map(configured.map((pl) => [pl.name, pl.id]));

      const plan = [];
      const notFound = {};
      let inTodoCount = 0;

      Object.keys(classification).forEach((uri) => {
        if (!todoTracks.has(uri)) return; // not currently in "Todo" — leave it alone entirely
        inTodoCount++;
        const targetName = classification[uri];
        const targetId = byName.get(targetName);
        if (targetId) {
          plan.push({ uri, trackName: todoTracks.get(uri) || uri, targetId, targetName });
        } else {
          notFound[targetName] = (notFound[targetName] || 0) + 1;
        }
      });

      bulkPlan = plan;
      bulkNotFound = notFound;
      bulkSourceId = sourceId;

      renderBulkSummary(Object.keys(classification).length, inTodoCount);
    } catch (e) {
      showToast("Error al cargar: " + e.message);
    } finally {
      btnBulkLoadJson.disabled = false;
      btnBulkLoadJson.textContent = originalLabel;
    }
  }

  function renderBulkSummary(totalInJson, inTodoCount) {
    const perPlaylist = {};
    bulkPlan.forEach((item) => {
      perPlaylist[item.targetName] = (perPlaylist[item.targetName] || 0) + 1;
    });

    let html = `<div class="bulk-block"><div class="bulk-block-title">${bulkPlan.length} canción(es) se moverán</div>`;
    html += `<div class="bulk-block-line"><span>En clasificacion.json</span><span>${totalInJson}</span></div>`;
    html += `<div class="bulk-block-line"><span>Encontradas en "Todo" ahora mismo</span><span>${inTodoCount}</span></div>`;
    Object.keys(perPlaylist).sort().forEach((name) => {
      html += `<div class="bulk-block-line"><span>${escapeHtml(name)}</span><span>${perPlaylist[name]}</span></div>`;
    });
    html += `</div>`;

    const notFoundNames = Object.keys(bulkNotFound);
    if (notFoundNames.length > 0) {
      const notFoundTotal = notFoundNames.reduce((sum, n) => sum + bulkNotFound[n], 0);
      html += `<div class="bulk-block"><div class="bulk-block-title bulk-warn">Playlist no encontrada — no se moverán ${notFoundTotal} canción(es)</div>`;
      notFoundNames.sort().forEach((name) => {
        html += `<div class="bulk-block-line"><span>${escapeHtml(name)}</span><span>${bulkNotFound[name]}</span></div>`;
      });
      html += `</div>`;
    }

    bulkSummary.innerHTML = html;
    bulkSummary.classList.remove("hidden");
    btnBulkConfirm.classList.toggle("hidden", bulkPlan.length === 0);
    if (bulkPlan.length === 0) showToast("No hay canciones para mover con la configuración actual");
  }

  function updateBulkProgress(done, total) {
    bulkProgressText.textContent = `${done} / ${total}`;
    bulkProgressFill.style.width = total ? `${(done / total) * 100}%` : "0%";
  }

  async function handleBulkConfirm() {
    if (bulkRunning || bulkPlan.length === 0) return;
    bulkRunning = true;
    btnBulkConfirm.classList.add("hidden");
    btnBulkLoadJson.disabled = true;
    bulkResult.classList.add("hidden");
    bulkResult.innerHTML = "";
    bulkProgress.classList.remove("hidden");

    const total = bulkPlan.length;
    let done = 0;
    let succeeded = 0;
    const addFailed = [];
    const removeFailed = [];

    updateBulkProgress(done, total);

    for (const item of bulkPlan) {
      const onWait = (remaining) => {
        bulkProgressText.textContent = `${done} / ${total} — Esperando por límite de Spotify… reintenta en ${remaining}s`;
      };

      const addRes = await bulkAddTrack(item.targetId, item.uri, onWait);
      if (addRes.ok) {
        if (playlistTrackCache[item.targetId]) playlistTrackCache[item.targetId].add(item.uri);

        const delRes = await bulkDeleteTrack(bulkSourceId, item.uri, onWait);
        if (delRes.ok) {
          succeeded++;
          if (playlistTrackCache[bulkSourceId]) playlistTrackCache[bulkSourceId].delete(item.uri);
        } else {
          removeFailed.push({ trackName: item.trackName, error: delRes.reason });
        }
      } else {
        addFailed.push({ trackName: item.trackName, error: addRes.reason });
      }
      done++;
      updateBulkProgress(done, total);
      await sleep(400);
    }

    bulkRunning = false;
    btnBulkLoadJson.disabled = false;
    renderBulkResult(succeeded, addFailed, removeFailed);
    updatePadIndicators();
  }

  function renderBulkResult(succeeded, addFailed, removeFailed) {
    const notFoundTotal = Object.values(bulkNotFound).reduce((a, b) => a + b, 0);

    let html = `<div class="bulk-block"><div class="bulk-block-title">Listo</div>`;
    html += `<div class="bulk-block-line"><span>Movidas con éxito</span><span>${succeeded}</span></div>`;
    html += `<div class="bulk-block-line"><span>Fallaron</span><span>${addFailed.length + removeFailed.length}</span></div>`;
    html += `<div class="bulk-block-line"><span>Saltadas (playlist no encontrada)</span><span>${notFoundTotal}</span></div>`;
    html += `</div>`;

    if (addFailed.length > 0) {
      html += `<div class="bulk-block"><div class="bulk-block-title bulk-warn">No se pudieron agregar (siguen en "Todo")</div>`;
      addFailed.forEach((f) => {
        html += `<div class="bulk-fail-item"><b>${escapeHtml(f.trackName)}</b><br>${escapeHtml(f.error)}</div>`;
      });
      html += `</div>`;
    }

    if (removeFailed.length > 0) {
      html += `<div class="bulk-block"><div class="bulk-block-title bulk-warn">Se agregaron pero no se pudieron quitar de "Todo"</div>`;
      removeFailed.forEach((f) => {
        html += `<div class="bulk-fail-item"><b>${escapeHtml(f.trackName)}</b><br>${escapeHtml(f.error)}</div>`;
      });
      html += `</div>`;
    }

    bulkResult.innerHTML = html;
    bulkResult.classList.remove("hidden");
    bulkProgress.classList.add("hidden");
    showToast(`Listo: ${succeeded} movidas, ${addFailed.length + removeFailed.length} con error`);
  }

  // ---------- Wire up ----------
  el("btn-connect").addEventListener("click", login);
  btnPrev.addEventListener("click", skipPrevious);
  btnPlayPause.addEventListener("click", togglePlayPause);
  btnNext.addEventListener("click", skipNext);
  btnRemoveCurrent.addEventListener("click", removeCurrentFromPlaylist);
  el("btn-empty-settings").addEventListener("click", openSettings);
  el("btn-settings").addEventListener("click", openSettings);
  el("btn-close-settings").addEventListener("click", closeSettings);
  el("btn-add-playlist").addEventListener("click", () => addPlaylistRow("", "", playlistRows.children.length));
  el("btn-pick-playlists").addEventListener("click", openPicker);
  el("btn-picker-confirm").addEventListener("click", confirmPicker);
  el("btn-picker-cancel").addEventListener("click", closePicker);
  pickerOverlay.addEventListener("click", (e) => { if (e.target === pickerOverlay) closePicker(); });
  el("btn-save-settings").addEventListener("click", saveSettingsFromForm);
  toggleRemoveOnAssign.addEventListener("change", () => {
    saveRemoveOnAssign(toggleRemoveOnAssign.checked);
    showToast(toggleRemoveOnAssign.checked
      ? "Activado: quitar de la playlist actual al asignar"
      : "Desactivado: quitar de la playlist actual al asignar");
  });
  el("btn-logout").addEventListener("click", () => { closeSettings(); logout(); });
  el("btn-copy-redirect").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inputRedirectUri.value);
      showToast("Copiado");
    } catch {
      showToast("No se pudo copiar, selecciónalo a mano");
    }
  });
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });
  el("btn-open-bulk-sort").addEventListener("click", openBulkSort);
  el("btn-close-bulk").addEventListener("click", closeBulkSort);
  btnBulkLoadJson.addEventListener("click", handleBulkLoad);
  btnBulkConfirm.addEventListener("click", handleBulkConfirm);
  bulkOverlay.addEventListener("click", (e) => { if (e.target === bulkOverlay) closeBulkSort(); });

  // ---------- Init ----------
  (async function init() {
    await handleRedirectIfNeeded();
    updateAuthUI();
  })();
})();
