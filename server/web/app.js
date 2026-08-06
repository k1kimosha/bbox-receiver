"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  profiles: [],
  host: "",
  stats: null,
  statsError: null,
  lastStreamids: null,
  me: null,
  users: [],
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
  const me = state.me || {};
  const isAdmin = me.role === "admin";
  const roleEl = $("#role-label");
  roleEl.classList.toggle("hidden", false);
  roleEl.textContent = isAdmin ? "администратор" : "пользователь";
  roleEl.className = "badge " + (isAdmin ? "online" : "offline");
  $("#users-btn").classList.toggle("hidden", !isAdmin);
  $("#stats-section").classList.toggle("hidden", !me.canViewStats);
  loadProfiles();
  if (me.canViewStats && !statsTimer) statsTimer = setInterval(fetchStats, 2000);
  if (me.canViewStats) fetchStats();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("#login-error");
  errorEl.classList.add("hidden");
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        user: $("#login-user").value.trim(),
        pass: $("#login-pass").value,
      }),
    });
    $("#login-pass").value = "";
    const session = await api("/api/session");
    state.me = session;
    showApp(session.user || $("#login-user").value.trim());
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

$("#users-btn").addEventListener("click", openUsersModal);

// ---- profiles --------------------------------------------------------------

async function loadProfiles() {
  try {
    const data = await api("/api/profiles");
    state.profiles = data.profiles || [];
    state.host = data.host || "";
    state.me = data.me || state.me;
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

  const me = state.me || {};
  const isAdmin = me.role === "admin";
  const limitReached = !isAdmin && me.maxProfiles >= 0 && me.createdProfiles >= me.maxProfiles;
  const addBtn = $("#add-profile-btn");
  if (limitReached) {
    addBtn.disabled = true;
    addBtn.title = "Достигнут лимит профилей";
  } else {
    addBtn.disabled = false;
    addBtn.removeAttribute("title");
  }
  const limitEl = $("#profile-limit");
  if (!isAdmin && me.maxProfiles >= 0) {
    limitEl.textContent = `(создано ${me.createdProfiles} из ${me.maxProfiles})`;
    limitEl.classList.remove("hidden");
  } else {
    limitEl.classList.add("hidden");
  }

  const online = onlineUsers();

  for (const profile of state.profiles) {
    const tr = document.createElement("tr");
    tr.dataset.user = profile.user;

    const userTd = document.createElement("td");
    userTd.textContent = profile.user;
    tr.appendChild(userTd);

    const ownerTd = document.createElement("td");
    ownerTd.textContent = profile.createdBy || "—";
    ownerTd.className = "muted small";
    tr.appendChild(ownerTd);

    const keyTd = document.createElement("td");
    const keyWrap = document.createElement("div");
    keyWrap.className = "key-cell";
    if (profile.canViewKey) {
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
    } else {
      const muted = document.createElement("span");
      muted.className = "muted";
      muted.textContent = "нет доступа";
      keyWrap.appendChild(muted);
    }
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
    if (profile.urls) {
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
    } else {
      const muted = document.createElement("span");
      muted.className = "muted";
      muted.textContent = "нет доступа";
      linksTd.appendChild(muted);
    }
    tr.appendChild(linksTd);

    const actionsTd = document.createElement("td");
    if (profile.canManage) {
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
    } else {
      const muted = document.createElement("span");
      muted.className = "muted";
      muted.textContent = "—";
      actionsTd.appendChild(muted);
    }
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

function modalFooter(cancelText = "Отмена", submitText = "Сохранить") {
  return `<div class="modal-footer">
    <button class="ghost" data-close>${escapeHtml(cancelText)}</button>
    <button class="primary" id="modal-submit">${escapeHtml(submitText)}</button>
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
    ${modalFooter("Отмена", "Создать")}
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
      <input type="text" id="edit-key" value="${escapeHtml(profile.key || "")}">
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

// ---- users admin (modal) ---------------------------------------------------

async function openUsersModal() {
  openModal(`<h2>Пользователи</h2><div id="users-content" class="muted">Загрузка…</div>`);
  await renderUsersList();
}

async function renderUsersList() {
  const content = $("#users-content");
  try {
    const data = await api("/api/users");
    state.users = data.users || [];
    let html = `
      <div class="toolbar">
        <button class="primary" id="user-add-btn">+ Создать пользователя</button>
      </div>
      <div class="table-scroll">
      <table class="table">
        <thead><tr>
          <th>Логин</th><th>Роль</th><th>Статистика</th><th>Лимит профилей</th><th>Создано</th><th>Действия</th>
        </tr></thead>
        <tbody>
    `;
    for (const u of state.users) {
      const role = u.role === "admin" ? "администратор" : "пользователь";
      const stats = u.canViewStats ? "да" : "нет";
      const limit = u.maxProfiles < 0 ? "∞" : u.maxProfiles;
      const isSelf = (state.me || {}).user === u.username;
      const rootBadge = u.isRoot ? " <span class='badge online'>root</span>" : "";
      const passBtn = u.isRoot && !isSelf
        ? `<button class="ghost tiny" disabled title="Пароль меняет только владелец">Пароль</button>`
        : `<button class="ghost tiny user-pass-btn">Пароль</button>`;
      const delBtn = u.isRoot
        ? `<button class="danger tiny" disabled title="Первого администратора нельзя удалить">Удалить</button>`
        : `<button class="danger tiny user-del-btn">Удалить</button>`;
      html += `<tr data-username="${escapeHtml(u.username)}">
        <td>${escapeHtml(u.username)}${rootBadge}</td>
        <td>${role}</td>
        <td>${stats}</td>
        <td>${limit}</td>
        <td>${u.profileCount}</td>
        <td>
          <div class="link-row">
            <button class="ghost tiny user-edit-btn">Права</button>
            ${passBtn}
            ${delBtn}
          </div>
        </td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
    content.innerHTML = html;

    $("#user-add-btn").addEventListener("click", openUserCreateModal);
    for (const btn of content.querySelectorAll(".user-edit-btn")) {
      const username = btn.closest("tr").dataset.username;
      btn.addEventListener("click", () => openUserRightsModal(username));
    }
    for (const btn of content.querySelectorAll(".user-pass-btn")) {
      const username = btn.closest("tr").dataset.username;
      btn.addEventListener("click", () => openUserPassModal(username));
    }
    for (const btn of content.querySelectorAll(".user-del-btn")) {
      const username = btn.closest("tr").dataset.username;
      btn.addEventListener("click", () => confirmDeleteUser(username));
    }
  } catch (err) {
    content.textContent = "Ошибка: " + err.message;
  }
}

function openUserCreateModal() {
  openModal(`
    <h2>Создать пользователя</h2>
    <label>Логин
      <input type="text" id="u-name" placeholder="например: streamer1" required>
    </label>
    <label>Пароль (минимум 6 символов)
      <input type="password" id="u-pass" required>
    </label>
    <label>Роль
      <select id="u-role">
        <option value="user">пользователь</option>
        <option value="admin">администратор</option>
      </select>
    </label>
    <label class="check">
      <input type="checkbox" id="u-stats" checked> Просмотр статистики
    </label>
    <label>Лимит профилей (−1 = без лимита)
      <input type="number" id="u-limit" value="3" min="-1" step="1">
    </label>
    <div id="modal-error" class="error hidden"></div>
    ${modalFooter("Отмена", "Создать")}
  `);
  wireModal(async () => {
    const username = $("#u-name").value.trim();
    const pass = $("#u-pass").value;
    if (!username) return showModalError("Укажите логин");
    if (pass.length < 6) return showModalError("Пароль должен быть не короче 6 символов");
    try {
      await api("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username,
          pass,
          role: $("#u-role").value,
          canViewStats: $("#u-stats").checked,
          maxProfiles: Number($("#u-limit").value),
        }),
      });
      closeModal();
      toast(`Пользователь «${username}» создан`);
      openUsersModal();
    } catch (err) {
      showModalError(err.message);
    }
  });
}

function openUserPassModal(username) {
  openModal(`
    <h2>Сменить пароль — ${escapeHtml(username)}</h2>
    <label>Новый пароль (минимум 6 символов)
      <input type="password" id="u-pass" required>
    </label>
    <div id="modal-error" class="error hidden"></div>
    ${modalFooter("Отмена", "Сохранить")}
  `);
  wireModal(async () => {
    const pass = $("#u-pass").value;
    if (pass.length < 6) return showModalError("Пароль должен быть не короче 6 символов");
    try {
      await api(`/api/users/${encodeURIComponent(username)}`, {
        method: "PUT",
        body: JSON.stringify({ pass }),
      });
      closeModal();
      toast("Пароль изменён");
      openUsersModal();
    } catch (err) {
      showModalError(err.message);
    }
  });
}

async function openUserRightsModal(username) {
  const me = state.me || {};
  const isSelf = me.user === username;
  const u = state.users.find((x) => x.username === username);
  const isRoot = !!(u && u.isRoot);
  openModal(`
    <h2>Права — ${escapeHtml(username)}${isRoot ? " <span class='badge online'>первый админ</span>" : ""}</h2>
    <div id="rights-content" class="muted">Загрузка…</div>
  `);
  try {
    const [profilesData, perms] = await Promise.all([
      api("/api/profiles"),
      api(`/api/perms/${encodeURIComponent(username)}`),
    ]);
    const myPerms = new Map(perms.perms.map((p) => [p.profileUser, p]));
    let rows = [];
    let html = "";
    const isAdmin = u ? u.role === "admin" : false;
    const canViewStats = u ? u.canViewStats : true;
    const maxProfiles = u ? u.maxProfiles : 3;
    html += `
      <div class="rights-account">
        <label>Роль
          <select id="u-role">
            <option value="user" ${!isAdmin ? "selected" : ""}>пользователь</option>
            <option value="admin" ${isAdmin ? "selected" : ""}>администратор</option>
          </select>
        </label>
        <label class="check">
          <input type="checkbox" id="u-stats" ${canViewStats ? "checked" : ""}> Просмотр статистики
        </label>
        <label>Лимит профилей (−1 = без лимита)
          <input type="number" id="u-limit" value="${maxProfiles}" min="-1" step="1">
        </label>
        <label>Новый пароль (оставьте пустым — без изменений)
          <input type="password" id="u-pass" ${isRoot && !isSelf ? "disabled placeholder='только владелец'" : ""}>
        </label>
        ${isRoot ? "<p class='muted small'>Первый администратор: роль не снимается, удаление запрещено, пароль меняет только владелец учётки.</p>" : ""}
      </div>
      <h3 class="rights-sub">Доступ к профилям</h3>
    `;
    for (const profile of profilesData.profiles) {
      const p = myPerms.get(profile.user) || { canViewKey: false, canManage: false };
      const isOwner = profile.createdBy === username;
      rows.push({ profile: profile.user, isOwner });
      html += `
        <div class="perm-row" data-profile="${escapeHtml(profile.user)}">
          <span class="perm-name">${escapeHtml(profile.user)}${isOwner ? " <span class='muted small'>(владелец)</span>" : ""}</span>
          <label class="check"><input type="checkbox" class="perm-view" ${p.canViewKey ? "checked" : ""} ${isOwner ? "disabled" : ""}> просмотр ключа</label>
          <label class="check"><input type="checkbox" class="perm-manage" ${p.canManage ? "checked" : ""} ${isOwner ? "disabled" : ""}> управление</label>
        </div>`;
    }
    html += `<div id="modal-error" class="error hidden"></div>
      <div class="modal-footer">
        <button class="ghost" data-close>Закрыть</button>
        <button class="primary" id="modal-submit">Сохранить</button>
      </div>`;
    $("#rights-content").innerHTML = html;
    if (isRoot && !isSelf) {
      $("#u-role").disabled = true;
    }
    wireModal(async () => {
      try {
        const pass = $("#u-pass").value;
        if (pass !== "" && pass.length < 6) return showModalError("Пароль должен быть не короче 6 символов");
        await api(`/api/users/${encodeURIComponent(username)}`, {
          method: "PUT",
          body: JSON.stringify({
            role: $("#u-role").value,
            canViewStats: $("#u-stats").checked,
            maxProfiles: Number($("#u-limit").value),
            pass: pass || undefined,
          }),
        });
        for (const row of rows) {
          const el = document.querySelector(`.perm-row[data-profile="${CSS.escape(row.profile)}"]`);
          if (!el || row.isOwner) continue;
          await api(`/api/perms/${encodeURIComponent(username)}/${encodeURIComponent(row.profile)}`, {
            method: "PUT",
            body: JSON.stringify({
              canViewKey: el.querySelector(".perm-view").checked,
              canManage: el.querySelector(".perm-manage").checked,
            }),
          });
        }
        closeModal();
        toast("Права сохранены");
        openUsersModal();
      } catch (err) {
        showModalError(err.message);
      }
    });
  } catch (err) {
    $("#rights-content").textContent = "Ошибка: " + err.message;
  }
}

function confirmDeleteUser(username) {
  openModal(`
    <h2>Удалить пользователя?</h2>
    <p>Пользователь <b>${escapeHtml(username)}</b> будет удалён.
    Его права на профили будут отозваны.</p>
    <div id="modal-error" class="error hidden"></div>
    <div class="modal-footer">
      <button class="ghost" data-close>Отмена</button>
      <button class="danger" id="modal-submit">Удалить</button>
    </div>
  `);
  wireModal(async () => {
    try {
      await api(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
      closeModal();
      toast("Пользователь удалён");
      openUsersModal();
    } catch (err) {
      showModalError(err.message);
    }
  });
}

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
    state.me = data;
    showApp(data.user);
  } catch {
    showLogin();
  }
})();
