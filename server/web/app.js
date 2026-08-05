"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  profiles: [],
  host: "",
  stats: null,
  statsError: null,
  lastStreamids: null,
};

let statsTimer = null;

// ---- helpers ---------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = "toast" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "toast hidden"), 3500);
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast("Скопировано"),
      () => fallbackCopy(text),
    );
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    toast("Скопировано");
  } catch {
    toast("Не удалось скопировать", true);
  }
  ta.remove();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Ошибка ${res.status}`);
  return data;
}

// ---- auth / views ----------------------------------------------------------

function showLogin() {
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

function showApp(user) {
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-label").textContent = user || "";
  loadProfiles();
  if (!statsTimer) statsTimer = setInterval(fetchStats, 2000);
  fetchStats();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("#login-error");
  errorEl.classList.add("hidden");
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        user: $("#login-user").value.trim(),
        pass: $("#login-pass").value,
      }),
    });
    $("#login-pass").value = "";
    showApp($("#login-user").value.trim());
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
});

$("#logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {}
  showLogin();
});

// ---- profiles --------------------------------------------------------------

async function loadProfiles() {
  try {
    const data = await api("/api/profiles");
    state.profiles = data.profiles || [];
    state.host = data.host || "";
    renderProfiles();
  } catch (err) {
    if (err.message !== "unauthorized") toast("Ошибка загрузки профилей: " + err.message, true);
  }
}

function renderProfiles() {
  const body = $("#profiles-body");
  body.innerHTML = "";
  $("#profiles-empty").classList.toggle("hidden", state.profiles.length > 0);
  $("#profiles-table").style.display = state.profiles.length ? "" : "none";

  const online = onlineUsers();

  for (const profile of state.profiles) {
    const tr = document.createElement("tr");
    tr.dataset.user = profile.user;

    const userTd = document.createElement("td");
    userTd.textContent = profile.user;
    tr.appendChild(userTd);

    const keyTd = document.createElement("td");
    const keyWrap = document.createElement("div");
    keyWrap.className = "key-cell";
    const keySpan = document.createElement("span");
    keySpan.className = "key";
    keySpan.dataset.value = profile.key;
    keySpan.textContent = profile.key;
    keyWrap.appendChild(keySpan);
    const eyeBtn = document.createElement("button");
    eyeBtn.className = "ghost tiny";
    eyeBtn.textContent = "👁";
    eyeBtn.title = "Показать/скрыть";
    eyeBtn.addEventListener("click", () => {
      keySpan.textContent = keySpan.textContent === profile.key ? "••••••••••••••••" : profile.key;
    });
    keyWrap.appendChild(eyeBtn);
    const copyKeyBtn = document.createElement("button");
    copyKeyBtn.className = "ghost tiny";
    copyKeyBtn.textContent = "⧉";
    copyKeyBtn.title = "Скопировать ключ";
    copyKeyBtn.addEventListener("click", () => copyText(profile.key));
    keyWrap.appendChild(copyKeyBtn);
    keyTd.appendChild(keyWrap);
    tr.appendChild(keyTd);

    const statusTd = document.createElement("td");
    const isOnline = online.has(profile.user);
    const badge = document.createElement("span");
    badge.className = "badge " + (isOnline ? "online" : "offline");
    badge.textContent = isOnline ? "онлайн" : "офлайн";
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);

    const linksTd = document.createElement("td");
    const linkRow = document.createElement("div");
    linkRow.className = "link-row";
    const select = document.createElement("select");
    select.className = "url-select";
    const urlOptions = [
      { label: "Publish SRT direct (:4001)", value: profile.urls.publishDirect },
      { label: "Play (:4000)", value: profile.urls.play },
      { label: "Play legacy (:8282)", value: profile.urls.legacy },
      { label: "Stats URL (:8181)", value: profile.urls.stats },
    ];
    for (const opt of urlOptions) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      select.appendChild(o);
    }
    linkRow.appendChild(select);
    const copyLinkBtn = document.createElement("button");
    copyLinkBtn.className = "ghost tiny";
    copyLinkBtn.textContent = "⧉";
    copyLinkBtn.title = "Скопировать выбранную ссылку";
    copyLinkBtn.addEventListener("click", () => copyText(select.value));
    linkRow.appendChild(copyLinkBtn);
    const belaboxBtn = document.createElement("button");
    belaboxBtn.className = "ghost tiny";
    belaboxBtn.textContent = "⚙";
    belaboxBtn.title = "Настройки Belabox (хост, порт, ключ)";
    belaboxBtn.addEventListener("click", () => openBelaboxModal(profile));
    linkRow.appendChild(belaboxBtn);
    linksTd.appendChild(linkRow);
    tr.appendChild(linksTd);

    const actionsTd = document.createElement("td");
    const actionsRow = document.createElement("div");
    actionsRow.className = "link-row";
    const editBtn = document.createElement("button");
    editBtn.className = "ghost";
    editBtn.textContent = "Изменить ключ";
    editBtn.addEventListener("click", () => openEditModal(profile));
    actionsRow.appendChild(editBtn);
    const delBtn = document.createElement("button");
    delBtn.className = "danger del-btn";
    delBtn.textContent = "Удалить";
    delBtn.dataset.user = profile.user;
    delBtn.addEventListener("click", () => openDeleteModal(profile));
    actionsRow.appendChild(delBtn);
    actionsTd.appendChild(actionsRow);
    tr.appendChild(actionsTd);

    body.appendChild(tr);
  }
}

// ---- modals ----------------------------------------------------------------

function openModal(html) {
  $("#modal").innerHTML = html;
  $("#modal-backdrop").classList.remove("hidden");
}

function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
}

function modalFooter(cancelText = "Отмена") {
  return `<div class="modal-footer">
    <button class="ghost" data-close>${escapeHtml(cancelText)}</button>
    <button class="primary" id="modal-submit">Сохранить</button>
  </div>`;
}

function wireModal(onSubmit) {
  $("#modal-submit").addEventListener("click", onSubmit);
}

async function generateInto(inputId) {
  try {
    const data = await api("/api/keygen", { method: "POST" });
    $("#" + inputId).value = data.key;
    toast("Ключ сгенерирован");
  } catch (err) {
    toast(err.message, true);
  }
}

function openAddModal() {
  openModal(`
    <h2>Добавить профиль</h2>
    <label>Имя пользователя
      <input type="text" id="add-user" placeholder="например: streamer1" required>
    </label>
    <label>Ключ (оставьте пустым — сгенерируется автоматически)
      <input type="text" id="add-key" placeholder="пусто = автогенерация">
    </label>
    <div class="link-row">
      <button class="ghost" id="add-gen-btn">Сгенерировать ключ</button>
    </div>
    <div id="modal-error" class="error hidden"></div>
    ${modalFooter("Отмена")}
  `);
  $("#add-gen-btn").addEventListener("click", () => generateInto("add-key"));
  wireModal(async () => {
    const user = $("#add-user").value.trim();
    const key = $("#add-key").value.trim();
    if (!user) return showModalError("Укажите имя пользователя");
    try {
      const data = await api("/api/profiles", {
        method: "POST",
        body: JSON.stringify({ user, key }),
      });
      closeModal();
      toast(`Профиль «${data.profile.user}» создан`);
      loadProfiles();
    } catch (err) {
      showModalError(err.message);
    }
  });
}

function openEditModal(profile) {
  openModal(`
    <h2>Изменить ключ — ${escapeHtml(profile.user)}</h2>
    <label>Новый ключ (оставьте пустым — сгенерируется автоматически)
      <input type="text" id="edit-key" value="${escapeHtml(profile.key)}">
    </label>
    <div class="link-row">
      <button class="ghost" id="edit-gen-btn">Сгенерировать ключ</button>
      <button class="ghost" id="edit-copy-btn">Копировать</button>
    </div>
    <div id="modal-error" class="error hidden"></div>
    ${modalFooter("Отмена")}
  `);
  $("#edit-gen-btn").addEventListener("click", () => generateInto("edit-key"));
  $("#edit-copy-btn").addEventListener("click", () => copyText($("#edit-key").value));
  wireModal(async () => {
    const key = $("#edit-key").value.trim();
    try {
      const data = await api(`/api/profiles/${encodeURIComponent(profile.user)}`, {
        method: "PUT",
        body: JSON.stringify({ key }),
      });
      closeModal();
      toast(`Ключ профиля «${data.profile.user}» обновлён`);
      loadProfiles();
    } catch (err) {
      showModalError(err.message);
    }
  });
}

function openDeleteModal(profile) {
  openModal(`
    <h2>Удалить профиль?</h2>
    <p>Профиль <b>${escapeHtml(profile.user)}</b> будет удалён безвозвратно.
    Активные подключения потеряют доступ.</p>
    <div id="modal-error" class="error hidden"></div>
    <div class="modal-footer">
      <button class="ghost" data-close>Отмена</button>
      <button class="danger" id="modal-submit">Удалить</button>
    </div>
  `);
  wireModal(async () => {
    try {
      await api(`/api/profiles/${encodeURIComponent(profile.user)}`, { method: "DELETE" });
      closeModal();
      toast("Профиль удалён");
      loadProfiles();
    } catch (err) {
      showModalError(err.message);
    }
  });
}

function showModalError(message) {
  const el = $("#modal-error");
  el.textContent = message;
  el.classList.remove("hidden");
}

$("#add-profile-btn").addEventListener("click", openAddModal);

// ---- stats ---------------------------------------------------------------

function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function publisherEntries() {
  const pubs = state.stats;
  if (!pubs || typeof pubs !== "object") return [];
  return Object.entries(pubs);
}

function parsePublisher(streamid, pub) {
  if (typeof pub !== "object" || pub === null) return null;
  const m = String(streamid || "").match(/live\/stream\/([^?/]+)/);
  const gap = pub.audioGapFill || {};
  return {
    user: m ? m[1] : null,
    streamid,
    bitrate: num(pub.bitrate),
    mbpsRecvRate: num(pub.mbpsRecvRate),
    rtt: num(pub.rtt),
    msRcvBuf: num(pub.msRcvBuf),
    latency: num(pub.latency),
    uptime: num(pub.uptime),
    bytesRcvDrop: num(pub.bytesRcvDrop),
    pktRcvLoss: num(pub.pktRcvLoss),
    pktRcvRetrans: num(pub.pktRcvRetrans),
    ringOverruns: num(pub.ringOverruns),
    sendBackpressure: num(pub.sendBackpressure),
    audioTracks: num(gap.audioTrackCount),
    raw: pub,
  };
}

function onlineUsers() {
  const result = new Set();
  for (const [streamid, pub] of publisherEntries()) {
    const parsed = parsePublisher(streamid, pub);
    if (parsed && parsed.user) result.add(parsed.user);
  }
  return result;
}

async function fetchStats() {
  try {
    const data = await api("/api/stats");
    state.stats = data && typeof data.publishers === "object" ? data.publishers : null;
    state.statsError = null;
  } catch (err) {
    if (err.message === "unauthorized") return;
    state.stats = null;
    state.statsError = err.message;
  }
  renderStats();
  updateStatuses();
}

function streamidSet() {
  const result = new Set();
  for (const [streamid] of publisherEntries()) result.add(streamid);
  return result;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function setField(card, field, text) {
  const el = card.querySelector(`[data-field="${field}"]`);
  if (el) el.textContent = text;
}

function publisherWarnings(p) {
  const warnings = [];
  if (p.pktRcvLoss > 0) warnings.push(`Потери пакетов: ${p.pktRcvLoss}`);
  if (p.bytesRcvDrop > 0) warnings.push(`Дроп байт: ${p.bytesRcvDrop}`);
  if (p.ringOverruns > 0) warnings.push(`Ring overruns: ${p.ringOverruns}`);
  if (p.sendBackpressure > 0) warnings.push(`Backpressure: ${p.sendBackpressure}`);
  return warnings;
}

function updateWarnings(card, p) {
  const warnings = publisherWarnings(p);
  let warnEl = card.querySelector(".stats-warn");
  if (warnings.length) {
    if (warnEl) {
      warnEl.innerHTML = warnings.map(escapeHtml).join("<br>");
    } else {
      warnEl = document.createElement("div");
      warnEl.className = "stats-warn";
      warnEl.innerHTML = warnings.map(escapeHtml).join("<br>");
      card.appendChild(warnEl);
    }
  } else if (warnEl) {
    warnEl.remove();
  }
}

function updateCardValues(card, p) {
  setField(card, "bitrate", p.bitrate != null ? p.bitrate + " kbps" : "—");
  setField(card, "rate", p.mbpsRecvRate != null ? p.mbpsRecvRate.toFixed(2) + " Mbps" : "—");
  setField(card, "uptime", p.uptime != null ? formatDuration(p.uptime) : "—");
  setField(card, "rtt", p.rtt != null ? p.rtt.toFixed(2) + " мс" : "—");
  setField(card, "buf", p.msRcvBuf != null ? p.msRcvBuf + " мс" : "—");
  setField(card, "latency", p.latency != null ? p.latency + " мс" : "—");
  setField(card, "loss", p.pktRcvLoss != null ? p.pktRcvLoss : "—");
  setField(card, "audio", p.audioTracks != null ? p.audioTracks : "—");
  updateWarnings(card, p);
}

function buildCard(streamid, p) {
  const card = document.createElement("div");
  card.className = "card stats-card";
  card.dataset.streamid = streamid;
  const user = p.user ? escapeHtml(p.user) : "<span class='muted'>—</span>";
  const rate = p.mbpsRecvRate != null ? p.mbpsRecvRate.toFixed(2) + " Mbps" : "—";
  const warnings = publisherWarnings(p);
  card.innerHTML = `
    <div class="stats-name">${user}</div>
    <div class="stats-grid">
      <div><span class="muted small">Битрейт</span><b data-field="bitrate">${p.bitrate != null ? p.bitrate + " kbps" : "—"}</b></div>
      <div><span class="muted small">Скорость приёма</span><b data-field="rate">${rate}</b></div>
      <div><span class="muted small">Эфир</span><b data-field="uptime">${p.uptime != null ? formatDuration(p.uptime) : "—"}</b></div>
      <div><span class="muted small">RTT</span><b data-field="rtt">${p.rtt != null ? p.rtt.toFixed(2) + " мс" : "—"}</b></div>
      <div><span class="muted small">Буфер</span><b data-field="buf">${p.msRcvBuf != null ? p.msRcvBuf + " мс" : "—"}</b></div>
      <div><span class="muted small">Latency</span><b data-field="latency">${p.latency != null ? p.latency + " мс" : "—"}</b></div>
      <div><span class="muted small">Потери</span><b data-field="loss">${p.pktRcvLoss != null ? p.pktRcvLoss : "—"}</b></div>
      <div><span class="muted small">Аудио дорожки</span><b data-field="audio">${p.audioTracks != null ? p.audioTracks : "—"}</b></div>
    </div>
    ${warnings.length ? `<div class="stats-warn">${warnings.map((w) => escapeHtml(w)).join("<br>")}</div>` : ""}
    <details><summary>Подробности</summary><pre>${escapeHtml(JSON.stringify(p.raw, null, 2))}</pre></details>
  `;
  return card;
}

function renderStats() {
  const statusEl = $("#stats-status");
  const cardsEl = $("#stats-cards");

  if (state.statsError) {
    statusEl.textContent = "Статистика недоступна: " + state.statsError;
    statusEl.classList.remove("hidden");
    cardsEl.innerHTML = "";
    state.lastStreamids = null;
    return;
  }
  if (!state.stats) {
    statusEl.textContent = "Загрузка…";
    statusEl.classList.remove("hidden");
    return;
  }
  const entries = publisherEntries();
  if (entries.length === 0) {
    statusEl.textContent = "Нет активных трансляций";
    statusEl.classList.remove("hidden");
    cardsEl.innerHTML = "";
    state.lastStreamids = null;
    return;
  }
  statusEl.classList.add("hidden");

  const newSet = streamidSet();
  if (state.lastStreamids && setsEqual(state.lastStreamids, newSet)) {
    for (const [streamid, pub] of entries) {
      const card = cardsEl.querySelector(`[data-streamid="${CSS.escape(streamid)}"]`);
      if (!card) continue;
      updateCardValues(card, parsePublisher(streamid, pub));
    }
    return;
  }

  cardsEl.innerHTML = "";
  state.lastStreamids = newSet;
  for (const [streamid, pub] of entries) {
    cardsEl.appendChild(buildCard(streamid, parsePublisher(streamid, pub)));
  }
}

function updateStatuses() {
  const online = onlineUsers();
  for (const tr of document.querySelectorAll("#profiles-body tr")) {
    const badge = tr.querySelector(".badge");
    if (!badge) continue;
    const isOnline = online.has(tr.dataset.user);
    badge.className = "badge " + (isOnline ? "online" : "offline");
    badge.textContent = isOnline ? "онлайн" : "офлайн";
    const delBtn = tr.querySelector(".del-btn");
    if (delBtn) {
      if (isOnline && !delBtn.disabled) {
        delBtn.disabled = true;
        delBtn.title = "Профиль в эфире — удаление недоступно";
      } else if (!isOnline && delBtn.disabled) {
        delBtn.disabled = false;
        delBtn.removeAttribute("title");
      }
    }
  }
}

function openBelaboxModal(profile) {
  const host = state.host || window.location.hostname;
  const port = 5000;
  const streamKey = `live/stream/${profile.user}?srtauth=${profile.key}`;
  openModal(`
    <h2>Belabox — настройки отправки</h2>
    <p class="muted small">Параметры указываются в Belabox отдельно. Ключ — поле Stream ID.</p>
    <label>Хост
      <div class="link-row">
        <input type="text" id="bb-host" value="${escapeHtml(host)}" readonly>
        <button class="ghost tiny" data-copy="bb-host">⧉</button>
      </div>
    </label>
    <label>Порт
      <div class="link-row">
        <input type="text" id="bb-port" value="${port}" readonly>
        <button class="ghost tiny" data-copy="bb-port">⧉</button>
      </div>
    </label>
    <label>Ключ отправки (Stream ID)
      <div class="link-row">
        <input type="text" id="bb-key" value="${escapeHtml(streamKey)}" readonly>
        <button class="ghost tiny" data-copy="bb-key">⧉</button>
      </div>
    </label>
    <div class="modal-footer">
      <button class="ghost" data-close>Закрыть</button>
    </div>
  `);
}

// ---- init ------------------------------------------------------------------

$("#modal").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-close], [data-copy]");
  if (!btn) return;
  if (btn.hasAttribute("data-close")) {
    closeModal();
  } else if (btn.hasAttribute("data-copy")) {
    const target = document.getElementById(btn.dataset.copy);
    if (target) copyText(target.value);
  }
});

$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target === $("#modal-backdrop")) closeModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal-backdrop").classList.contains("hidden")) {
    closeModal();
  }
});

(async function init() {
  try {
    const data = await api("/api/session");
    showApp(data.user);
  } catch {
    showLogin();
  }
})();
