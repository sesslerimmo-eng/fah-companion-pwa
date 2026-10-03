"use strict";

// ============================================================================
// Service worker (hors ligne) + bannière d'installation
// ============================================================================

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

let deferredInstallPrompt = null;
const installBanner = document.getElementById("install-banner");
const installBtn = document.getElementById("install-btn");

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBanner.classList.add("visible");
});

installBtn.addEventListener("click", async () => {
  installBanner.classList.remove("visible");
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
});

window.addEventListener("appinstalled", () => {
  installBanner.classList.remove("visible");
});

// ============================================================================
// Onglets
// ============================================================================

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = true));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
  });
});

document.querySelectorAll(".sub-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sub-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".sub-panel").forEach((p) => (p.hidden = true));
    btn.classList.add("active");
    document.getElementById(`live-${btn.dataset.subtab}-panel`).hidden = false;
  });
});

// ============================================================================
// Constantes communes (alignées sur FAH Project Monitor)
// ============================================================================

const EVENT_LABELS = {
  new: "🆕 Nouveau",
  modified: "🔄 Modifié",
  removed: "❌ Disparu",
  reactivated: "🟢 Réapparu",
};

const MAX_STORED_EVENTS = 2000;

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatNumber(value) {
  if (!isNumber(value)) return String(value);
  return Number.isInteger(value) ? value.toLocaleString("fr-FR") : String(value);
}

function projectSummary(project, projectId) {
  const parts = [`P${projectId}`];
  if (!project || typeof project !== "object") return parts[0];

  const title = typeof project.title === "string" ? project.title.trim() : "";
  if (title && title.toLowerCase() !== `p${projectId}`.toLowerCase()) {
    parts.push(title.slice(0, 60));
  }

  if (isNumber(project.atoms)) parts.push(`${formatNumber(project.atoms)} atomes`);
  if (isNumber(project.credit)) parts.push(`${formatNumber(project.credit)} pts`);

  const flags = [];
  if (project.beta === true) flags.push("bêta");
  if (project.public === false) flags.push("privé");
  if (flags.length) parts.push(flags.join("/"));

  if (typeof project.contact === "string" && project.contact.trim()) {
    parts.push(`contact ${project.contact.trim().slice(0, 30)}`);
  }

  return parts.join(" · ");
}

function summarizeChanges(changes, limit = 3) {
  if (!changes || typeof changes !== "object") return "";

  const entries = Object.entries(changes)
    .slice(0, limit)
    .map(([field, values]) => {
      if (!values || typeof values !== "object") return null;
      return `${field}: ${formatNumber(values.old)} → ${formatNumber(values.new)}`;
    })
    .filter(Boolean);

  const remaining = Object.keys(changes).length - entries.length;
  if (remaining > 0) entries.push(`+${remaining} autre(s)`);

  return entries.join(" | ");
}

function formatDate(iso) {
  return iso ? String(iso).replace("T", " ") : "";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function flattenDict(data, prefix = "") {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    let result = {};
    for (const [key, value] of Object.entries(data)) {
      result = { ...result, ...flattenDict(value, prefix ? `${prefix}.${key}` : key) };
    }
    return result;
  }
  if (Array.isArray(data)) {
    let result = {};
    data.forEach((value, index) => {
      const path = prefix ? `${prefix}[${index}]` : `[${index}]`;
      result = { ...result, ...flattenDict(value, path) };
    });
    return result;
  }
  return { [prefix]: data };
}

function compareProjects(oldProject, newProject) {
  const oldFlat = flattenDict(oldProject);
  const newFlat = flattenDict(newProject);
  const changes = {};

  for (const field of new Set([...Object.keys(oldFlat), ...Object.keys(newFlat)])) {
    const oldValue = oldFlat[field];
    const newValue = newFlat[field];
    if (oldValue !== newValue) changes[field] = { old: oldValue ?? null, new: newValue ?? null };
  }

  return changes;
}

// ============================================================================
// Détail (modale partagée)
// ============================================================================

const detailDialog = document.getElementById("detail-dialog");
const detailBody = document.getElementById("detail-body");
document.getElementById("detail-close").addEventListener("click", () => detailDialog.close());
detailDialog.addEventListener("click", (event) => {
  if (event.target === detailDialog) detailDialog.close();
});

function showDetail(event) {
  const lines = [
    `Type : ${EVENT_LABELS[event.event_type] || event.event_type}`,
    `Date : ${formatDate(event.detected_at)}`,
    `Projet : P${event.project_id}`,
    "",
  ];

  if (event.changes) lines.push("MODIFICATIONS", JSON.stringify(event.changes, null, 2), "");
  if (event.project) lines.push("ÉTAT DU PROJET", JSON.stringify(event.project, null, 2));

  detailBody.innerHTML = `<pre>${escapeHtml(lines.join("\n"))}</pre>`;

  if (typeof detailDialog.showModal === "function") {
    detailDialog.showModal();
  } else {
    alert(lines.join("\n"));
  }
}

// ============================================================================
// Contrôleur de liste générique (utilisé par l'onglet Direct ET Import)
// ============================================================================

function createListController(ids) {
  const el = {
    statsCard: document.getElementById(ids.statsCard),
    statsGrid: document.getElementById(ids.statsGrid),
    emptyState: document.getElementById(ids.emptyState),
    listSection: document.getElementById(ids.listSection),
    eventList: document.getElementById(ids.eventList),
    resultCount: document.getElementById(ids.resultCount),
    searchInput: document.getElementById(ids.searchInput),
    typeFilter: document.getElementById(ids.typeFilter),
  };

  let events = [];

  function computeStats(list) {
    const stats = { new: 0, modified: 0, removed: 0, reactivated: 0 };
    for (const event of list) if (event.event_type in stats) stats[event.event_type] += 1;
    return stats;
  }

  function matchesFilters(event, query, type) {
    if (type && event.event_type !== type) return false;
    if (!query) return true;

    const haystack = [
      event.project_id,
      event.event_type,
      event.detected_at,
      JSON.stringify(event.changes || ""),
      event.project ? JSON.stringify(event.project) : "",
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query.toLowerCase());
  }

  function render() {
    if (events.length === 0) {
      el.statsCard.hidden = true;
      el.emptyState.hidden = false;
      el.listSection.hidden = true;
      return;
    }

    el.statsCard.hidden = false;
    el.emptyState.hidden = true;
    el.listSection.hidden = false;

    const stats = computeStats(events);
    const tiles = [
      ["Total", events.length, ""],
      ["Nouveaux", stats.new, "🆕"],
      ["Modifiés", stats.modified, "🔄"],
      ["Disparus", stats.removed, "❌"],
      ["Réapparus", stats.reactivated, "🟢"],
    ];

    el.statsGrid.innerHTML = tiles
      .map(
        ([label, value, emoji]) =>
          `<div class="stat-tile"><div class="value">${emoji} ${value}</div><div class="label">${label}</div></div>`
      )
      .join("");

    const query = el.searchInput.value.trim();
    const type = el.typeFilter.value;

    const sorted = [...events].sort((a, b) =>
      String(b.detected_at).localeCompare(String(a.detected_at))
    );

    const filtered = sorted.filter((event) => matchesFilters(event, query, type));

    el.resultCount.textContent = `${filtered.length} / ${events.length} événement(s)`;

    const fragment = document.createDocumentFragment();

    filtered.slice(0, 500).forEach((event) => {
      const item = document.createElement("div");
      item.className = `event-item ${event.event_type}`;

      const summary = projectSummary(event.project, event.project_id);
      const detail = event.event_type === "modified" ? summarizeChanges(event.changes) : "";

      item.innerHTML = `
        <div class="top-line">
          <span>${EVENT_LABELS[event.event_type] || event.event_type}</span>
          <span>${formatDate(event.detected_at)}</span>
        </div>
        <div class="summary">${escapeHtml(summary)}</div>
        ${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ""}
      `;

      item.addEventListener("click", () => showDetail(event));
      fragment.appendChild(item);
    });

    el.eventList.innerHTML = "";
    el.eventList.appendChild(fragment);
  }

  el.searchInput.addEventListener("input", render);
  el.typeFilter.addEventListener("change", render);

  return {
    setEvents(list) {
      events = list;
      render();
    },
    render,
  };
}

// ============================================================================
// ONGLET IMPORT — charge un export JSON/CSV de FAH Project Monitor
// ============================================================================

const importController = createListController({
  statsCard: "stats-card",
  statsGrid: "stats-grid",
  emptyState: "empty-state",
  listSection: "list-section",
  eventList: "event-list",
  resultCount: "result-count",
  searchInput: "search-input",
  typeFilter: "type-filter",
});

const sourceLabel = document.getElementById("source-label");
const fileInput = document.getElementById("file-input");

document.getElementById("pick-file").addEventListener("click", () => fileInput.click());

document.getElementById("clear-data").addEventListener("click", () => {
  importController.setEvents([]);
  try {
    localStorage.removeItem("fah-companion-import-events");
    localStorage.removeItem("fah-companion-import-label");
  } catch (_err) {
    /* ignore */
  }
  sourceLabel.textContent = "Aucun fichier chargé";
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = () => {
    try {
      const text = String(reader.result);
      const parsed = file.name.toLowerCase().endsWith(".csv")
        ? parseCsv(text)
        : parseJson(text);

      importController.setEvents(parsed);
      sourceLabel.textContent = `${file.name} · ${parsed.length} événement(s)`;

      try {
        localStorage.setItem(
          "fah-companion-import-events",
          JSON.stringify(parsed.slice(0, MAX_STORED_EVENTS))
        );
        localStorage.setItem("fah-companion-import-label", sourceLabel.textContent);
      } catch (_err) {
        /* stockage indisponible : sans gravité */
      }
    } catch (err) {
      alert("Impossible de lire ce fichier : " + err.message);
    }
  };

  reader.onerror = () => alert("Erreur de lecture du fichier.");
  reader.readAsText(file, "utf-8");
  fileInput.value = "";
});

function parseJson(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("format JSON inattendu.");

  return data.map((row) => ({
    id: row.id,
    detected_at: row.detected_at,
    event_type: row.event_type,
    project_id: String(row.project_id),
    changes: row.changes || null,
    project: row.project || null,
  }));
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // ignoré
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const typeMap = { nouveau: "new", modifié: "modified", disparu: "removed", réapparu: "reactivated" };
  const unescapeFormula = (value) =>
    value.startsWith("'") && /^[=+\-@]/.test(value.slice(1)) ? value.slice(1) : value;

  return rows
    .slice(1)
    .filter((r) => r.length >= 5)
    .map((r) => {
      let changes = null;
      const rawChanges = unescapeFormula(r[4] || "");

      if (rawChanges) {
        try {
          changes = JSON.parse(rawChanges);
        } catch (_err) {
          changes = null;
        }
      }

      const rawType = (r[2] || "").trim();

      return {
        id: r[0],
        detected_at: unescapeFormula(r[1] || ""),
        event_type: typeMap[rawType.toLowerCase()] || rawType,
        project_id: String(unescapeFormula(r[3] || "")),
        changes,
        project: null,
      };
    });
}

(function restoreImport() {
  try {
    const raw = localStorage.getItem("fah-companion-import-events");
    const label = localStorage.getItem("fah-companion-import-label");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      importController.setEvents(parsed);
      sourceLabel.textContent = label || "Données précédentes";
    }
  } catch (_err) {
    /* stockage corrompu ou indisponible : repart à vide */
  }
})();

// ============================================================================
// ONGLET DIRECT — interroge l'API officielle Folding@home depuis le téléphone
// ============================================================================
//
// api.foldingathome.org/as (liste des serveurs d'assignation) n'autorise le
// CORS que pour l'origine officielle apps.foldingathome.org : impossible à
// appeler depuis cette app. En revanche /api/project/summary de chaque
// serveur d'assignation (assign1, assign2...) autorise CORS pour tout le
// monde (Access-Control-Allow-Origin: *). La liste des serveurs est donc
// fixe ici, modifiable à la main si Folding@home en ajoute.

const DEFAULT_SERVERS = ["assign1.foldingathome.org", "assign2.foldingathome.org"];
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MASS_DISAPPEAR_RATIO = 0.3;
const MASS_DISAPPEAR_MIN_COUNT = 10;
const REMOVAL_GRACE_CHECKS = 2;

const liveController = createListController({
  statsCard: "live-stats-card",
  statsGrid: "live-stats-grid",
  emptyState: "live-empty-state",
  listSection: "live-list-section",
  eventList: "live-event-list",
  resultCount: "live-result-count",
  searchInput: "live-search-input",
  typeFilter: "live-type-filter",
});

const liveStatusText = document.getElementById("live-status-text");
const liveSubText = document.getElementById("live-sub-text");
const liveDot = document.getElementById("live-dot");
const liveCheckBtn = document.getElementById("live-check-btn");
const liveSettingsBtn = document.getElementById("live-settings-btn");
const liveSettingsCard = document.getElementById("live-settings-card");
const liveServersInput = document.getElementById("live-servers-input");
const liveAutoToggle = document.getElementById("live-auto-toggle");
const liveIntervalSelect = document.getElementById("live-interval");
const notifPermissionRow = document.getElementById("notif-permission-row");
const notifPermissionBtn = document.getElementById("notif-permission-btn");

let liveTimer = null;
let liveChecking = false;

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_err) {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_err) {
    /* stockage indisponible : sans gravité, juste pas persisté */
  }
}

function getServers() {
  const stored = loadJson("fah-companion-servers", null);
  return Array.isArray(stored) && stored.length ? stored : DEFAULT_SERVERS;
}

function validServerList(text) {
  const names = text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);

  for (const name of names) {
    if (!HOSTNAME_PATTERN.test(name) || !name.endsWith("foldingathome.org")) {
      throw new Error(`Hôte invalide : ${name}`);
    }
  }

  if (names.length === 0) throw new Error("Au moins un serveur est requis.");
  return names;
}

liveSettingsBtn.addEventListener("click", () => {
  liveServersInput.value = getServers().join("\n");
  liveSettingsCard.hidden = !liveSettingsCard.hidden;
});

// ------------------------------------------------------------------------
// Liste "Projets actifs" : toujours la liste complète du dernier instantané
// connu, indépendamment des changements détectés. C'est elle qui répond à
// « pourquoi je ne vois rien la première fois ? » — les changements, eux,
// n'existent qu'à partir de la 2e vérification.
// ------------------------------------------------------------------------

const liveProjectsEmpty = document.getElementById("live-projects-empty");
const liveProjectsSection = document.getElementById("live-projects-section");
const liveProjectsList = document.getElementById("live-projects-list");
const liveProjectsCount = document.getElementById("live-projects-count");
const liveProjectsSearch = document.getElementById("live-projects-search");

let lastKnownProjects = {};

function renderProjectList() {
  const ids = Object.keys(lastKnownProjects);

  if (ids.length === 0) {
    liveProjectsEmpty.hidden = false;
    liveProjectsSection.hidden = true;
    return;
  }

  liveProjectsEmpty.hidden = true;
  liveProjectsSection.hidden = false;

  const query = liveProjectsSearch.value.trim().toLowerCase();

  const sortedIds = [...ids].sort((a, b) =>
    /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)
  );

  const summaries = sortedIds.map((id) => ({
    id,
    text: projectSummary(lastKnownProjects[id], id),
  }));

  const filtered = query
    ? summaries.filter((p) => p.text.toLowerCase().includes(query))
    : summaries;

  liveProjectsCount.textContent = `${filtered.length} / ${ids.length} projet(s)`;

  const fragment = document.createDocumentFragment();

  filtered.slice(0, 500).forEach((p) => {
    const item = document.createElement("div");
    item.className = "project-item";
    item.textContent = p.text;
    item.addEventListener("click", () =>
      showDetail({
        event_type: "info",
        detected_at: "",
        project_id: p.id,
        project: lastKnownProjects[p.id],
        changes: null,
      })
    );
    fragment.appendChild(item);
  });

  liveProjectsList.innerHTML = "";
  liveProjectsList.appendChild(fragment);
}

liveProjectsSearch.addEventListener("input", renderProjectList);

EVENT_LABELS.info = "ℹ️ Projet";

document.getElementById("live-servers-save").addEventListener("click", () => {
  try {
    const servers = validServerList(liveServersInput.value);
    saveJson("fah-companion-servers", servers);
    liveSettingsCard.hidden = true;
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("live-servers-reset").addEventListener("click", () => {
  saveJson("fah-companion-servers", DEFAULT_SERVERS);
  liveServersInput.value = DEFAULT_SERVERS.join("\n");
});

function setLiveStatus(text, sub, tone) {
  liveStatusText.textContent = text;
  liveSubText.textContent = sub;
  liveDot.className = `dot ${tone}`;
}

async function fetchProjects() {
  const servers = getServers();
  let lastError = null;

  for (const host of servers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(`https://${host}/api/project/summary`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      clearTimeout(timeout);

      if (!response.ok) throw new Error(`HTTP ${response.status} (${host})`);

      const data = await response.json();
      if (!Array.isArray(data)) throw new Error(`réponse inattendue de ${host}`);

      return data;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("aucun serveur n'a répondu.");
}

function normalizeProjects(raw) {
  const result = {};
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = item.id ?? item.project ?? item.project_id;
    if (id === undefined || id === null || String(id).trim() === "") continue;
    result[String(id).trim()] = item;
  }
  return result;
}

function buildLiveEvents(known, current, missingCounts) {
  const knownIds = new Set(Object.keys(known));
  const currentIds = new Set(Object.keys(current));

  const newIds = [...currentIds].filter((id) => !knownIds.has(id));
  const stayingIds = [...currentIds].filter((id) => knownIds.has(id));

  const removedIds = [];
  const pendingMissing = {};

  for (const id of knownIds) {
    if (currentIds.has(id)) continue;
    const absences = (missingCounts[id] || 0) + 1;
    if (absences >= REMOVAL_GRACE_CHECKS) removedIds.push(id);
    else pendingMissing[id] = absences;
  }

  const modified = {};
  for (const id of stayingIds) {
    const changes = compareProjects(known[id], current[id]);
    if (Object.keys(changes).length) modified[id] = changes;
  }

  const now = new Date().toISOString();
  const events = [];

  const sortNumeric = (ids) =>
    [...ids].sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)));

  for (const id of sortNumeric(newIds)) {
    events.push({ detected_at: now, event_type: "new", project_id: id, project: current[id], changes: null });
  }
  for (const id of sortNumeric(Object.keys(modified))) {
    events.push({ detected_at: now, event_type: "modified", project_id: id, project: current[id], changes: modified[id] });
  }
  for (const id of sortNumeric(removedIds)) {
    events.push({ detected_at: now, event_type: "removed", project_id: id, project: known[id], changes: null });
  }

  return { events, pendingMissing, removedIds };
}

function maybeNotify(events, projectCount) {
  if (events.length === 0) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const counts = { new: 0, modified: 0, removed: 0 };
  for (const event of events) counts[event.event_type] = (counts[event.event_type] || 0) + 1;

  const body =
    `${projectCount} projets · 🆕 ${counts.new} · 🔄 ${counts.modified} · ❌ ${counts.removed}\n` +
    events.slice(0, 3).map((e) => `${EVENT_LABELS[e.event_type]} P${e.project_id}`).join("\n");

  try {
    new Notification("FAH Companion", { body, icon: "icons/icon-192.png", tag: "fah-companion" });
  } catch (_err) {
    /* navigateur sans notifications locales (rare) : on ignore */
  }
}

async function runLiveCheck(auto = false) {
  if (liveChecking) return;
  liveChecking = true;
  liveCheckBtn.disabled = true;

  setLiveStatus("Vérification en cours...", "", "warn");

  try {
    const raw = await fetchProjects();
    const current = normalizeProjects(raw);
    const projectCount = Object.keys(current).length;

    if (projectCount === 0) throw new Error("aucun projet reçu.");

    const known = loadJson("fah-companion-live-known", null);
    const missingCounts = loadJson("fah-companion-live-missing", {});

    if (!known) {
      // Première vérification : pas de comparaison possible, mais la liste
      // complète des projets actifs est déjà consultable.
      saveJson("fah-companion-live-known", current);
      saveJson("fah-companion-live-missing", {});
      lastKnownProjects = current;
      renderProjectList();
      setLiveStatus(
        `Initialisé : ${projectCount} projets`,
        `Dernière vérification : ${formatDate(new Date().toISOString())}`,
        "ok"
      );
      return;
    }

    const knownCount = Object.keys(known).length;
    const vanished = Object.keys(known).filter((id) => !(id in current)).length;

    if (
      knownCount &&
      vanished >= MASS_DISAPPEAR_MIN_COUNT &&
      vanished / knownCount > MASS_DISAPPEAR_RATIO
    ) {
      throw new Error(
        `réponse suspecte ignorée (${vanished}/${knownCount} projets absents d'un coup).`
      );
    }

    const { events, pendingMissing, removedIds } = buildLiveEvents(known, current, missingCounts);

    const nextKnown = { ...known };
    for (const [id, project] of Object.entries(current)) nextKnown[id] = project;
    for (const id of removedIds) delete nextKnown[id];

    saveJson("fah-companion-live-known", nextKnown);
    saveJson("fah-companion-live-missing", pendingMissing);
    lastKnownProjects = nextKnown;
    renderProjectList();

    if (events.length > 0) {
      const history = [...events, ...loadJson("fah-companion-live-events", [])].slice(
        0,
        MAX_STORED_EVENTS
      );
      saveJson("fah-companion-live-events", history);
      liveController.setEvents(history);
      maybeNotify(events, projectCount);
    }

    setLiveStatus(
      `${projectCount} projets · ${events.length} changement(s)`,
      `Dernière vérification : ${formatDate(new Date().toISOString())}`,
      "ok"
    );
  } catch (err) {
    setLiveStatus("Erreur", err.message, "err");
    if (!auto) alert("Vérification impossible : " + err.message);
  } finally {
    liveChecking = false;
    liveCheckBtn.disabled = false;
  }
}

liveCheckBtn.addEventListener("click", () => runLiveCheck(false));

function scheduleAuto() {
  if (liveTimer) clearInterval(liveTimer);
  if (!liveAutoToggle.checked) return;

  const minutes = Number(liveIntervalSelect.value) || 15;
  liveTimer = setInterval(() => runLiveCheck(true), minutes * 60 * 1000);
}

liveAutoToggle.addEventListener("change", () => {
  saveJson("fah-companion-auto", { enabled: liveAutoToggle.checked, minutes: Number(liveIntervalSelect.value) });
  scheduleAuto();
});

liveIntervalSelect.addEventListener("change", () => {
  saveJson("fah-companion-auto", { enabled: liveAutoToggle.checked, minutes: Number(liveIntervalSelect.value) });
  scheduleAuto();
});

notifPermissionBtn.addEventListener("click", async () => {
  const result = await Notification.requestPermission();
  if (result === "granted") notifPermissionRow.hidden = true;
});

(function initLive() {
  const history = loadJson("fah-companion-live-events", []);
  liveController.setEvents(history);

  const known = loadJson("fah-companion-live-known", null);
  if (known) {
    lastKnownProjects = known;
    renderProjectList();
    setLiveStatus(`${Object.keys(known).length} projets connus`, "Touche « Vérifier » pour mettre à jour.", "ok");
  }

  const auto = loadJson("fah-companion-auto", { enabled: false, minutes: 15 });
  liveAutoToggle.checked = !!auto.enabled;
  liveIntervalSelect.value = String(auto.minutes || 15);
  scheduleAuto();

  if ("Notification" in window && Notification.permission === "default") {
    notifPermissionRow.hidden = false;
  }
})();
