(() => {
  "use strict";

  // ---------- Config ----------
  const SCOPES = "user-read-currently-playing playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative";
  const PAD_COLORS = ["#FF6B6B", "#4ECDC4", "#FFD93D", "#A78BFA", "#6BCB77", "#FF8FAB", "#5EA8ED", "#F4977C"];
  const POLL_MS = 5000;

  const LS = {
    clientId: "pp_client_id",
    playlists: "pp_playlists",
    access: "pp_access_token",
    refresh: "pp_refresh_token",
    expires: "pp_expires_at",
    verifier: "pp_code_verifier",
    state: "pp_oauth_state",
  };

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

  const pickerOverlay = el("picker-overlay");
  const pickerStatus = el("picker-status");
  const pickerList = el("picker-list");

  let currentTrackUri = null;
  let pollTimer = null;

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
        setNowPlaying(null);
        return;
      }
      if (res.status === 401) {
        const fresh = await refreshAccessToken();
        if (!fresh) updateAuthUI();
        return;
      }
      if (!res.ok) return;

      const data = await res.json();
      if (!data || !data.item) { setNowPlaying(null); return; }
      setNowPlaying(data.item);
    } catch {
      // network hiccup, try again next tick
    }
  }

  function setNowPlaying(item) {
    if (!item) {
      currentTrackUri = null;
      npStatus.textContent = "NADA SONANDO";
      npTitle.textContent = "—";
      npArtist.textContent = "";
      npDot.classList.remove("live");
      artImg.classList.remove("has-art");
      setPadsEnabled(false);
      return;
    }
    currentTrackUri = item.uri;
    npStatus.textContent = "REPRODUCIENDO";
    npTitle.textContent = item.name || "—";
    npArtist.textContent = (item.artists || []).map((a) => a.name).join(", ");
    npDot.classList.add("live");
    const img = item.album && item.album.images && item.album.images[item.album.images.length - 1];
    if (img) {
      artImg.src = img.url;
      artImg.classList.add("has-art");
    } else {
      artImg.classList.remove("has-art");
    }
    setPadsEnabled(true);
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
      btn.style.background = PAD_COLORS[i % PAD_COLORS.length];
      btn.innerHTML = `<span>${escapeHtml(pl.name)}</span><span class="pad-check">✓</span>`;
      btn.addEventListener("click", () => assignToPad(pl, btn));
      padGrid.appendChild(btn);
    });
    setPadsEnabled(!!currentTrackUri);
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  async function assignToPad(playlist, btnEl) {
    if (!currentTrackUri) {
      showToast("No hay ninguna canción sonando ahorita");
      return;
    }
    const token = await ensureFreshToken();
    if (!token) { showToast("Conecta tu cuenta de Spotify"); updateAuthUI(); return; }

    try {
      const res = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/items`, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ uris: [currentTrackUri] }),
      });

      if (res.status === 201) {
        btnEl.classList.remove("flash");
        void btnEl.offsetWidth;
        btnEl.classList.add("flash");
        showToast(`Agregada a ${playlist.name}`);
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
      row.innerHTML = `
        <input type="checkbox" id="pick-${pl.id}" data-id="${pl.id}" data-name="${escapeHtml(pl.name)}" ${already ? "checked disabled" : ""} />
        <label for="pick-${pl.id}">${escapeHtml(pl.name)}${already ? " (ya agregada)" : ""}</label>
      `;
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
    row.innerHTML = `
      <span class="swatch" style="background:${swatchColor}"></span>
      <input type="text" class="pl-name" placeholder="Nombre (ej. Perreo)" value="${escapeHtml(name || "")}" />
      <input type="text" class="pl-link" placeholder="Link o ID de la playlist" value="${escapeHtml(idOrLink || "")}" />
      <button class="btn-remove" aria-label="Quitar">×</button>
    `;
    row.querySelector(".btn-remove").addEventListener("click", () => row.remove());
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

  // ---------- Wire up ----------
  el("btn-connect").addEventListener("click", login);
  el("btn-empty-settings").addEventListener("click", openSettings);
  el("btn-settings").addEventListener("click", openSettings);
  el("btn-close-settings").addEventListener("click", closeSettings);
  el("btn-add-playlist").addEventListener("click", () => addPlaylistRow("", "", playlistRows.children.length));
  el("btn-pick-playlists").addEventListener("click", openPicker);
  el("btn-picker-confirm").addEventListener("click", confirmPicker);
  el("btn-picker-cancel").addEventListener("click", closePicker);
  pickerOverlay.addEventListener("click", (e) => { if (e.target === pickerOverlay) closePicker(); });
  el("btn-save-settings").addEventListener("click", saveSettingsFromForm);
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

  // ---------- Init ----------
  (async function init() {
    await handleRedirectIfNeeded();
    updateAuthUI();
  })();
})();
