// Tension Mirror - single-file frontend, no dependencies.
// Filter state lives here; every change re-fetches /api/climbs and re-renders.

const PAGE_SIZE = 24;

const state = {
  page: 0,
  total: 0,
  onlyClassics: true,
  onlyFavorites: false,
  angle: "any",
  minGrade: GRADES[0][0],
  maxGrade: GRADES[GRADES.length - 1][0],
  minAscents: 1,
  minQuality: 1.0,
  sortBy: "difficulty",
  sortOrder: "asc",
  name: "",
};

// ---------- Board viewer ----------
// Draws the board image(s) once, then just toggles which hold circles are
// visible/colored when a climb is selected (see showClimb below).

function drawBoard() {
  const svg = document.getElementById("svg-climb");
  for (const [imageUrl, holds] of Object.entries(IMAGES_TO_HOLDS)) {
    const imageEl = document.createElementNS("http://www.w3.org/2000/svg", "image");
    imageEl.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", imageUrl);
    svg.appendChild(imageEl);

    const img = new Image();
    img.onload = () => {
      svg.setAttribute("viewBox", `0 0 ${img.width} ${img.height}`);
      const xSpacing = img.width / (EDGE_RIGHT - EDGE_LEFT);
      const ySpacing = img.height / (EDGE_TOP - EDGE_BOTTOM);
      for (const [holdId, mirroredHoldId, x, y] of holds) {
        if (x <= EDGE_LEFT || x >= EDGE_RIGHT || y <= EDGE_BOTTOM || y >= EDGE_TOP) continue;
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("id", `hold-${holdId}`);
        circle.setAttribute("cx", (x - EDGE_LEFT) * xSpacing);
        circle.setAttribute("cy", img.height - (y - EDGE_BOTTOM) * ySpacing);
        circle.setAttribute("r", xSpacing * 4);
        circle.setAttribute("fill-opacity", 0);
        circle.setAttribute("stroke-opacity", 0);
        circle.setAttribute("stroke-width", 6);
        svg.appendChild(circle);
      }
    };
    img.src = imageUrl;
  }
}

// ---------- Tabs ----------

const TAB_VIEWS = ["browse-view", "plusone-view", "history-view"];

document.getElementById("tabs").addEventListener("click", (event) => {
  const tab = event.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");
  const target = tab.dataset.tab;
  for (const view of TAB_VIEWS) {
    document.getElementById(view).hidden = view !== target;
  }
  if (target === "history-view") loadHistory();
});

// ---------- +1 game ----------
// Every hold on the board (not tied to any particular climb) is clickable.
// Holds show no marker by default - just the board photo. Clicking one
// adds it as the next move (small blue dot); clicking the last-added one
// again undoes it.

const plusOneSequence = [];
const plusOneDots = {};

function drawPlusOneBoard() {
  const svg = document.getElementById("svg-plusone");
  for (const [imageUrl, holds] of Object.entries(IMAGES_TO_HOLDS)) {
    const imageEl = document.createElementNS("http://www.w3.org/2000/svg", "image");
    imageEl.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", imageUrl);
    svg.appendChild(imageEl);

    const img = new Image();
    img.onload = () => {
      svg.setAttribute("viewBox", `0 0 ${img.width} ${img.height}`);
      const xSpacing = img.width / (EDGE_RIGHT - EDGE_LEFT);
      const ySpacing = img.height / (EDGE_TOP - EDGE_BOTTOM);
      for (const [holdId, , x, y] of holds) {
        if (x <= EDGE_LEFT || x >= EDGE_RIGHT || y <= EDGE_BOTTOM || y >= EDGE_TOP) continue;
        if (plusOneDots[holdId]) continue;

        const cx = (x - EDGE_LEFT) * xSpacing;
        const cy = img.height - (y - EDGE_BOTTOM) * ySpacing;

        // Invisible, full-size click target over the hold.
        const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        hitArea.setAttribute("cx", cx);
        hitArea.setAttribute("cy", cy);
        hitArea.setAttribute("r", xSpacing * 4);
        hitArea.setAttribute("fill-opacity", 0);
        hitArea.addEventListener("click", () => onPlusOneHoldClick(holdId));
        svg.appendChild(hitArea);

        // Small blue dot shown only once this hold is picked.
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", cx);
        dot.setAttribute("cy", cy);
        dot.setAttribute("r", xSpacing * 1.6);
        dot.setAttribute("fill", "#2563eb");
        dot.setAttribute("fill-opacity", 0);
        dot.style.pointerEvents = "none";
        svg.appendChild(dot);
        plusOneDots[holdId] = dot;
      }
    };
    img.src = imageUrl;
  }
}

function setPlusOneHoldState(holdId, isSelected) {
  const dot = plusOneDots[holdId];
  if (!dot) return;
  dot.setAttribute("fill-opacity", isSelected ? 1 : 0);
}

// All +1 holds light up on the real board in one color (blue, role 6),
// matching the on-screen dot - there's no per-hold role/color concept here
// the way there is for a saved climb.
const PLUSONE_LED_ROLE = "6";

function illuminatePlusOneSequence() {
  if (!hasNativeBluetoothBridge() && !navigator.bluetooth) return; // no popup spam on every click
  const frames = plusOneSequence.map((id) => `p${id}r${PLUSONE_LED_ROLE}`).join("");
  const packet = getBluetoothPacket(frames, PLACEMENT_POSITIONS, LED_COLORS);
  illuminateClimb(BOARD, packet, "plusone");
}

function onPlusOneHoldClick(holdId) {
  const lastId = plusOneSequence[plusOneSequence.length - 1];
  if (holdId === lastId) {
    plusOneSequence.pop();
    setPlusOneHoldState(holdId, false);
    updatePlusOneCount();
    illuminatePlusOneSequence();
    return;
  }
  if (plusOneSequence.includes(holdId)) {
    return; // already used earlier in the sequence
  }
  plusOneSequence.push(holdId);
  setPlusOneHoldState(holdId, true);
  updatePlusOneCount();
  illuminatePlusOneSequence();
}

function updatePlusOneCount() {
  const n = plusOneSequence.length;
  document.getElementById("plusone-count").textContent =
    n === 0 ? "No moves yet" : n === 1 ? "1 move" : `${n} moves`;
}

document.getElementById("plusone-undo").addEventListener("click", () => {
  const lastId = plusOneSequence[plusOneSequence.length - 1];
  if (lastId !== undefined) onPlusOneHoldClick(lastId);
});

document.getElementById("plusone-reset").addEventListener("click", () => {
  while (plusOneSequence.length) {
    setPlusOneHoldState(plusOneSequence.pop(), false);
  }
  updatePlusOneCount();
  illuminatePlusOneSequence();
});

// ---------- Rest timer ----------
// Global (header) countdown for resting between attempts - not tied to
// any tab, so it's visible whether you're browsing, in the +1 game, or
// looking at history. Hit "Start rest" for a fresh countdown each time.

let restTimerDuration = 180;
let restTimerRemaining = 180;
let restTimerHandle = null;
let restTimerAudioContext = null;

function formatTimer(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateRestTimerDisplay() {
  const el = document.getElementById("rest-timer-display");
  el.textContent = formatTimer(restTimerRemaining);
  el.classList.toggle("is-running", restTimerHandle !== null);
  el.classList.toggle("is-done", restTimerRemaining === 0 && restTimerHandle === null);
}

function playTimerBeep() {
  try {
    if (!restTimerAudioContext) {
      restTimerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = restTimerAudioContext;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.6);
  } catch (error) {
    // Web Audio unavailable - the visual "done" state is enough on its own.
  }
}

function stopRestTimer() {
  if (restTimerHandle) {
    clearInterval(restTimerHandle);
    restTimerHandle = null;
  }
}

function startRestTimer() {
  stopRestTimer();
  restTimerRemaining = restTimerDuration;
  document.getElementById("rest-timer-toggle").textContent = "Stop";
  restTimerHandle = setInterval(() => {
    restTimerRemaining -= 1;
    if (restTimerRemaining <= 0) {
      restTimerRemaining = 0;
      stopRestTimer();
      document.getElementById("rest-timer-toggle").textContent = "Start rest";
      playTimerBeep();
    }
    updateRestTimerDisplay();
  }, 1000);
  updateRestTimerDisplay();
}

document.getElementById("rest-timer-toggle").addEventListener("click", () => {
  if (restTimerHandle) {
    stopRestTimer();
    restTimerRemaining = restTimerDuration;
    document.getElementById("rest-timer-toggle").textContent = "Start rest";
    updateRestTimerDisplay();
  } else {
    startRestTimer();
  }
});

document.getElementById("rest-timer-length").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#rest-timer-length .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");

  restTimerDuration = Number(chip.dataset.seconds);
  stopRestTimer();
  restTimerRemaining = restTimerDuration;
  document.getElementById("rest-timer-toggle").textContent = "Start rest";
  updateRestTimerDisplay();
});

updateRestTimerDisplay();

let loggedIn = false;
let currentClimb = null;

function showClimb(climb) {
  currentClimb = climb;
  document.querySelectorAll('#svg-climb circle[stroke-opacity="1"]').forEach((c) => {
    c.setAttribute("stroke-opacity", 0);
  });

  for (const frame of climb.frames.split("p")) {
    if (!frame) continue;
    const [placementId, colorId] = frame.split("r");
    const circle = document.getElementById(`hold-${placementId}`);
    if (!circle) continue;
    circle.setAttribute("stroke", COLORS[colorId]);
    circle.setAttribute("stroke-opacity", 1);
  }

  document.getElementById("viewer-name").textContent = climb.name;
  updateViewerFavoriteButton();

  const errorPrefix = climb.grade_error > 0 ? "+" : "-";
  const errorSuffix = String(Math.abs(climb.grade_error).toFixed(2)).replace(/^0+/, "");
  const classicBadge = climb.benchmark_difficulty !== null ? " ©" : "";
  const progressBadge = climb.sent
    ? ` ✓ Sent${climb.send_count > 1 ? ` ×${climb.send_count}` : ""}`
    : climb.tries > 0
    ? ` • Tried ${climb.tries}×`
    : "";
  document.getElementById("viewer-meta").textContent = climb.grade
    ? `${climb.grade} (${errorPrefix}${errorSuffix}) at ${climb.angle}°${classicBadge}${progressBadge}`
    : "";

  document.getElementById("viewer-setter").textContent = climb.setter_username
    ? `Set by ${climb.setter_username}`
    : "";

  const description = (climb.description || "").trim();
  document.getElementById("viewer-description").textContent = description;
  document.getElementById("viewer-description").hidden = description === "";

  document.getElementById("viewer-link").href = `${APP_URL}/climbs/${climb.uuid}`;
  document.getElementById("viewer-backdrop").classList.add("open");

  document.getElementById("viewer-actions").hidden = !loggedIn;
  document.getElementById("log-ascent-button").textContent = climb.sent
    ? "Log another send ✓"
    : "Mark as sent ✓";
  document.getElementById("viewer-log-error").textContent = "";
}

function updateViewerFavoriteButton() {
  const button = document.getElementById("viewer-favorite");
  const favorited = Boolean(currentClimb && currentClimb.favorited);
  button.textContent = favorited ? "♥" : "♡";
  button.classList.toggle("is-favorited", favorited);
}

async function toggleFavorite(climb) {
  if (!loggedIn) {
    openLogin();
    return;
  }
  try {
    const response = await fetch("/api/toggle-favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ climb_uuid: climb.uuid, angle: climb.angle }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to update favorite");
    climb.favorited = data.favorited;
    if (currentClimb && currentClimb.uuid === climb.uuid && currentClimb.angle === climb.angle) {
      currentClimb.favorited = data.favorited;
      updateViewerFavoriteButton();
    }
    loadClimbs();
  } catch (error) {
    console.error("Error toggling favorite:", error);
  }
}

document.getElementById("viewer-favorite").addEventListener("click", () => {
  if (currentClimb) toggleFavorite(currentClimb);
});

async function logTry() {
  if (!currentClimb) return;
  const button = document.getElementById("log-try-button");
  const errorEl = document.getElementById("viewer-log-error");
  errorEl.textContent = "";
  button.disabled = true;
  try {
    const response = await fetch("/api/log-try", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ climb_uuid: currentClimb.uuid, angle: currentClimb.angle }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to log try");
    currentClimb.tries = data.tries;
    showClimb(currentClimb);
    loadClimbs();
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function logAscent() {
  if (!currentClimb) return;
  const button = document.getElementById("log-ascent-button");
  const errorEl = document.getElementById("viewer-log-error");
  errorEl.textContent = "";
  button.disabled = true;
  try {
    const response = await fetch("/api/log-ascent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ climb_uuid: currentClimb.uuid, angle: currentClimb.angle }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to log ascent");
    currentClimb.sent = true;
    currentClimb.send_count = data.send_count;
    showClimb(currentClimb);
    loadClimbs();
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.getElementById("log-try-button").addEventListener("click", logTry);
document.getElementById("log-ascent-button").addEventListener("click", logAscent);

document.getElementById("illuminate-button").addEventListener("click", () => {
  const errorEl = document.getElementById("illuminate-error");
  errorEl.textContent = "";
  if (!currentClimb) return;
  if (!navigator.bluetooth && !hasNativeBluetoothBridge()) {
    errorEl.textContent = "Web Bluetooth isn't supported in this browser (try Chrome on desktop/Android).";
    return;
  }
  const packet = getBluetoothPacket(currentClimb.frames, PLACEMENT_POSITIONS, LED_COLORS);
  illuminateClimb(BOARD, packet);
});

function closeViewer() {
  document.getElementById("viewer-backdrop").classList.remove("open");
}

// ---------- Grade selects ----------

const minGradeSelect = document.getElementById("min-grade");
const maxGradeSelect = document.getElementById("max-grade");
for (const [difficulty, label] of GRADES) {
  minGradeSelect.add(new Option(label, difficulty));
  maxGradeSelect.add(new Option(label, difficulty));
}
minGradeSelect.value = state.minGrade;
maxGradeSelect.value = state.maxGrade;

minGradeSelect.addEventListener("change", () => {
  state.minGrade = Number(minGradeSelect.value);
  if (state.minGrade > state.maxGrade) {
    state.maxGrade = state.minGrade;
    maxGradeSelect.value = state.maxGrade;
  }
  resetPageAndReload();
});

maxGradeSelect.addEventListener("change", () => {
  state.maxGrade = Number(maxGradeSelect.value);
  if (state.maxGrade < state.minGrade) {
    state.minGrade = state.maxGrade;
    minGradeSelect.value = state.minGrade;
  }
  resetPageAndReload();
});

// ---------- Classics toggle ----------

const classicsToggle = document.getElementById("classics");
classicsToggle.addEventListener("click", () => {
  state.onlyClassics = !state.onlyClassics;
  classicsToggle.setAttribute("data-on", state.onlyClassics);
  resetPageAndReload();
});

const favoritesToggle = document.getElementById("favorites-only");
favoritesToggle.addEventListener("click", () => {
  state.onlyFavorites = !state.onlyFavorites;
  favoritesToggle.setAttribute("data-on", state.onlyFavorites);
  resetPageAndReload();
});

// ---------- Angle chips ----------

document.getElementById("angle-chips").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#angle-chips .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  state.angle = chip.dataset.angle;
  resetPageAndReload();
});

// ---------- Name search ----------

let nameDebounce;
document.getElementById("name").addEventListener("input", (event) => {
  clearTimeout(nameDebounce);
  nameDebounce = setTimeout(() => {
    state.name = event.target.value;
    resetPageAndReload();
  }, 300);
});

// ---------- Advanced filters ----------

document.getElementById("min-ascents").addEventListener("change", (event) => {
  state.minAscents = Number(event.target.value) || 0;
  resetPageAndReload();
});

const minQualityInput = document.getElementById("min-quality");
const minQualityLabel = document.getElementById("min-quality-value");
minQualityInput.addEventListener("input", (event) => {
  minQualityLabel.textContent = Number(event.target.value).toFixed(1);
});
minQualityInput.addEventListener("change", (event) => {
  state.minQuality = Number(event.target.value);
  resetPageAndReload();
});

// ---------- Sort ----------

document.getElementById("sort-by").addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  resetPageAndReload();
});

const sortOrderButton = document.getElementById("sort-order");
sortOrderButton.addEventListener("click", () => {
  state.sortOrder = state.sortOrder === "desc" ? "asc" : "desc";
  sortOrderButton.setAttribute("data-order", state.sortOrder);
  resetPageAndReload();
});

// ---------- Pager ----------

document.getElementById("prev-page").addEventListener("click", () => {
  if (state.page > 0) {
    state.page -= 1;
    loadClimbs();
  }
});

document.getElementById("next-page").addEventListener("click", () => {
  if ((state.page + 1) * PAGE_SIZE < state.total) {
    state.page += 1;
    loadClimbs();
  }
});

function resetPageAndReload() {
  state.page = 0;
  loadClimbs();
}

// ---------- Fetch + render ----------

async function loadClimbs() {
  const grid = document.getElementById("climb-grid");
  grid.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
  document.getElementById("results-count").textContent = "Loading climbs…";

  const params = new URLSearchParams({
    minGrade: state.minGrade,
    maxGrade: state.maxGrade,
    minAscents: state.minAscents,
    minQuality: state.minQuality,
    onlyClassics: state.onlyClassics ? "1" : "0",
    onlyFavorites: state.onlyFavorites ? "1" : "0",
    angle: state.angle,
    name: state.name,
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    page: state.page,
    pageSize: PAGE_SIZE,
  });

  try {
    const response = await fetch(`/api/climbs?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.total = data.total;
    renderClimbs(data.climbs);
    renderPager();
  } catch (error) {
    grid.innerHTML = `<div class="error-state">Couldn't load climbs (${error.message}).</div>`;
    document.getElementById("results-count").textContent = "Error loading climbs";
  }
}

function renderClimbs(climbs) {
  const grid = document.getElementById("climb-grid");
  document.getElementById("results-count").textContent =
    state.total === 1 ? "1 climb" : `${state.total.toLocaleString()} climbs`;

  if (climbs.length === 0) {
    grid.innerHTML = '<div class="empty-state">No climbs match these filters.</div>';
    return;
  }

  grid.innerHTML = "";
  for (const climb of climbs) {
    const errorPrefix = climb.grade_error > 0 ? "+" : "-";
    const errorSuffix = String(Math.abs(climb.grade_error).toFixed(2)).replace(/^0+/, "");
    const card = document.createElement("button");
    card.type = "button";
    card.className = "climb-card";
    if (climb.sent) card.classList.add("is-sent");
    else if (climb.tries > 0) card.classList.add("is-project");
    card.innerHTML = `
      <div class="climb-top">
        <p class="climb-name">${escapeHtml(climb.name)}</p>
        <span style="display:flex; gap:6px; align-items:center;">
          ${climb.sent ? `<span class="climb-sent-badge" title="Sent${climb.send_count > 1 ? ` ${climb.send_count} times` : ""}">✓${climb.send_count > 1 ? ` ${climb.send_count}` : ""}</span>` : ""}
          ${!climb.sent && climb.tries > 0 ? `<span class="climb-tries-badge">Tried ${climb.tries}×</span>` : ""}
          ${climb.benchmark_difficulty !== null ? '<span class="climb-classic">★</span>' : ""}
          <span class="climb-favorite-btn${climb.favorited ? " is-favorited" : ""}" title="Favorite">${climb.favorited ? "♥" : "♡"}</span>
        </span>
      </div>
      <div>
        <span class="grade-pill">${escapeHtml(climb.grade || "?")}</span>
        <span> (${errorPrefix}${errorSuffix}) at ${climb.angle}°</span>
      </div>
      <div class="climb-stats">
        <span>★ ${climb.quality_average ? Number(climb.quality_average).toFixed(2) : "–"}</span>
        <span>${climb.ascensionist_count.toLocaleString()} ascents</span>
      </div>
      <div class="climb-setter">by ${escapeHtml(climb.setter_username || "unknown")}</div>
    `;
    card.addEventListener("click", () => showClimb(climb));
    card.querySelector(".climb-favorite-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(climb);
    });
    grid.appendChild(card);
  }
}

function renderPager() {
  const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  document.getElementById("pager-label").textContent = `Page ${state.page + 1} of ${totalPages}`;
  document.getElementById("prev-page").disabled = state.page <= 0;
  document.getElementById("next-page").disabled = (state.page + 1) * PAGE_SIZE >= state.total;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : value;
  return div.innerHTML;
}

document.getElementById("viewer-close").addEventListener("click", closeViewer);
document.getElementById("viewer-backdrop").addEventListener("click", (event) => {
  if (event.target.id === "viewer-backdrop") closeViewer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeViewer();
});

// ---------- Login / account ----------

const loginBackdrop = document.getElementById("login-backdrop");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const accountEl = document.getElementById("account");

function openLogin() {
  loginError.textContent = "";
  loginForm.reset();
  loginBackdrop.classList.add("open");
}

function closeLogin() {
  loginBackdrop.classList.remove("open");
}

document.getElementById("login-close").addEventListener("click", closeLogin);
loginBackdrop.addEventListener("click", (event) => {
  if (event.target.id === "login-backdrop") closeLogin();
});

function renderAccount(isLoggedIn) {
  loggedIn = isLoggedIn;
  accountEl.innerHTML = isLoggedIn
    ? '<span>Logged in</span><button type="button" class="btn-link" id="logout-button">Log out</button><button type="button" class="btn-link" id="refresh-progress-button">Refresh</button>'
    : '<button type="button" class="btn" id="login-button">Log in</button>';

  if (isLoggedIn) {
    document.getElementById("logout-button").addEventListener("click", logout);
    document.getElementById("refresh-progress-button").addEventListener("click", refreshProgress);
  } else {
    document.getElementById("login-button").addEventListener("click", openLogin);
  }
}

async function checkLoginState() {
  const response = await fetch("/api/me");
  const data = await response.json();
  renderAccount(data.logged_in);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const username = document.getElementById("login-username").value;
  const password = document.getElementById("login-password").value;

  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json();

  if (!response.ok) {
    loginError.textContent = data.error || "Login failed.";
    return;
  }

  closeLogin();
  renderAccount(true);
  loadClimbs();
});

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  renderAccount(false);
  loadClimbs();
}

async function refreshProgress() {
  await fetch("/api/refresh-progress", { method: "POST" });
  loadClimbs();
}

// ---------- History ----------
// One row per logged send (see /api/log-ascent), grouped by calendar day.

async function loadHistory() {
  const container = document.getElementById("history-content");

  if (!loggedIn) {
    container.innerHTML = '<div class="empty-state">Log in to see your climb history.</div>';
    return;
  }

  container.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
  try {
    const response = await fetch("/api/history");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load history");
    renderHistory(data.entries);
  } catch (error) {
    container.innerHTML = `<div class="error-state">Couldn't load history (${error.message}).</div>`;
  }
}

function renderHistory(entries) {
  const container = document.getElementById("history-content");
  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state">No sends logged yet. Use "Mark as sent" on a climb to start your history.</div>';
    return;
  }

  const groups = new Map();
  for (const entry of entries) {
    const dateKey = new Date(entry.logged_at).toDateString();
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(entry);
  }

  container.innerHTML = "";
  for (const dayEntries of groups.values()) {
    const dayEl = document.createElement("div");
    dayEl.className = "history-day";

    const heading = document.createElement("h3");
    const date = new Date(dayEntries[0].logged_at);
    const dayLabel = date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    heading.textContent = `${dayLabel} · ${dayEntries.length} climb${dayEntries.length === 1 ? "" : "s"}`;
    dayEl.appendChild(heading);

    const list = document.createElement("div");
    list.className = "history-list";
    for (const entry of dayEntries) {
      const time = new Date(entry.logged_at).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      const row = document.createElement("div");
      row.className = "history-row";
      row.innerHTML = `
        <span class="history-time">${time}</span>
        <span class="history-name">${escapeHtml(entry.name)}</span>
        <span class="grade-pill">${escapeHtml(entry.grade || "?")}</span>
        <span class="history-angle">${entry.angle}°</span>
        ${entry.benchmark_difficulty !== null ? '<span class="climb-classic">★</span>' : ""}
      `;
      list.appendChild(row);
    }
    dayEl.appendChild(list);
    container.appendChild(dayEl);
  }
}

renderAccount(false);
checkLoginState();
drawBoard();
drawPlusOneBoard();
loadClimbs();
