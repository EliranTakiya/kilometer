const STORAGE_KEY = "kilometer-fleet-v1";
const VEHICLE_COUNT = 24;
const SUPABASE_URL = window.APP_CONFIG?.supabaseUrl?.replace(/\/$/, "") || "";
const SUPABASE_KEY = window.APP_CONFIG?.supabasePublishableKey || "";

const vehicleList = document.querySelector("#vehicle-list");
const searchInput = document.querySelector("#vehicle-search");
const emptyState = document.querySelector("#empty-state");
const toast = document.querySelector("#toast");
const connectionStatus = document.querySelector("#connection-status");
const connectionNote = document.querySelector("#connection-note");
let vehicles = createEmptyVehicles();
let cloudReady = false;
let toastTimer;
const pendingSaveTimers = new Map();
const saveQueues = new Map();

function createEmptyVehicles() {
  return Array.from({ length: VEHICLE_COUNT }, (_, index) => ({ id: index + 1, km: "" }));
}

function loadLocalVehicles() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return Array.from({ length: VEHICLE_COUNT }, (_, index) => {
      const id = index + 1;
      const value = saved[id];
      return { id, km: Number.isFinite(value) && value >= 0 ? value : "" };
    });
  } catch {
    return Array.from({ length: VEHICLE_COUNT }, (_, index) => ({ id: index + 1, km: "" }));
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("he-IL").format(value);
}

function renderVehicles() {
  const query = searchInput.value.trim();
  const filtered = vehicles.filter(({ id }) => String(id).includes(query));
  vehicleList.replaceChildren();

  filtered.forEach(({ id, km }, index) => {
    const row = document.createElement("div");
    row.className = `vehicle-row${km !== "" ? " is-updated" : ""}`;
    row.style.animationDelay = `${Math.min(index, 8) * 18}ms`;

    const identity = document.createElement("div");
    identity.className = "vehicle-id";
    const number = document.createElement("span");
    number.className = "vehicle-number";
    number.textContent = String(id).padStart(2, "0");
    const name = document.createElement("span");
    name.textContent = `רכב ${id}`;
    identity.append(number, name);

    const field = document.createElement("label");
    field.className = "km-field";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.inputMode = "numeric";
    input.dataset.vehicleId = id;
    input.disabled = !cloudReady;
    input.placeholder = "הקלידו קילומטראז׳";
    input.setAttribute("aria-label", `קילומטראז׳ נוכחי, רכב ${id}`);
    input.value = km === "" ? "" : km;
    input.addEventListener("input", () => updateMileage(id, input.value));
    const unit = document.createElement("span");
    unit.textContent = "ק״מ";
    field.append(input, unit);

    const status = document.createElement("span");
    status.className = "row-status";
    status.textContent = !cloudReady ? "לא מחובר" : km === "" ? "ממתין לעדכון" : "עודכן";
    row.append(identity, field, status);
    vehicleList.append(row);
  });

  emptyState.hidden = filtered.length !== 0;
  document.querySelector("#list-count").textContent = `${filtered.length} רכבים`;
}

function updateMileage(id, rawValue) {
  const parsed = rawValue === "" ? "" : Number(rawValue);
  if (!cloudReady || (parsed !== "" && (!Number.isFinite(parsed) || parsed < 0))) return;

  vehicles = vehicles.map((vehicle) => vehicle.id === id ? { ...vehicle, km: parsed } : vehicle);
  updateSummary();

  const row = [...vehicleList.children].find((element) => element.querySelector(".vehicle-number")?.textContent === String(id).padStart(2, "0"));
  if (row) {
    row.querySelector(".row-status").textContent = "שומר...";
  }
  scheduleMileageSave(id);
}

function isCloudConfigured() {
  return SUPABASE_URL.startsWith("https://") && SUPABASE_KEY.length > 10 && !SUPABASE_URL.includes("YOUR_PROJECT") && !SUPABASE_KEY.includes("YOUR_");
}

function setConnectionState(status, note, connected = false) {
  connectionStatus.textContent = status;
  connectionNote.lastChild.textContent = note;
  connectionStatus.parentElement.classList.toggle("is-connected", connected);
}

function supabaseHeaders(prefer) {
  const headers = {
    apikey: SUPABASE_KEY,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

async function fetchCloudVehicles() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/vehicle_mileage?select=id,km`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Could not load mileage (${response.status})`);
  return response.json();
}

async function saveCloudVehicles(records) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/vehicle_mileage?on_conflict=id`, {
    method: "POST",
    headers: supabaseHeaders("resolution=merge-duplicates,return=minimal"),
    body: JSON.stringify(records.map(({ id, km }) => ({ id, km: km === "" ? null : km })))
  });
  if (!response.ok) throw new Error(`Could not save mileage (${response.status})`);
}

function normalizeCloudMileage(value) {
  if (value === null || value === undefined) return "";
  const mileage = Number(value);
  return Number.isFinite(mileage) && mileage >= 0 ? mileage : "";
}

function applyCloudVehicles(rows) {
  const cloudValues = new Map(rows.map(({ id, km }) => [Number(id), normalizeCloudMileage(km)]));
  const focusedId = Number(document.activeElement?.dataset?.vehicleId);
  vehicles = vehicles.map((vehicle) => {
    if (pendingSaveTimers.has(vehicle.id) || saveQueues.has(vehicle.id) || vehicle.id === focusedId) return vehicle;
    return { ...vehicle, km: cloudValues.get(vehicle.id) ?? "" };
  });

  vehicles.forEach(({ id, km }) => {
    const input = vehicleList.querySelector(`[data-vehicle-id="${id}"]`);
    if (!input) return;
    input.value = km;
    const row = input.closest(".vehicle-row");
    row.classList.toggle("is-updated", km !== "");
    row.querySelector(".row-status").textContent = km === "" ? "ממתין לעדכון" : "עודכן";
  });
  updateSummary();
}

function scheduleMileageSave(id) {
  clearTimeout(pendingSaveTimers.get(id));
  const timer = setTimeout(() => {
    pendingSaveTimers.delete(id);
    const record = vehicles.find((vehicle) => vehicle.id === id);
    const previousSave = saveQueues.get(id) || Promise.resolve();
    const currentSave = previousSave.catch(() => {}).then(() => saveCloudVehicles([record]));
    saveQueues.set(id, currentSave);

    currentSave.then(() => {
      if (saveQueues.get(id) !== currentSave) return;
      saveQueues.delete(id);
      const row = vehicleList.querySelector(`[data-vehicle-id="${id}"]`)?.closest(".vehicle-row");
      if (row) {
        row.classList.toggle("is-updated", record.km !== "");
        row.querySelector(".row-status").textContent = record.km === "" ? "ממתין לעדכון" : "עודכן";
      }
      setConnectionState("מסונכרן", "הנתונים מסתנכרנים בין המכשירים", true);
    }).catch(() => {
      if (saveQueues.get(id) !== currentSave) return;
      saveQueues.delete(id);
      const row = vehicleList.querySelector(`[data-vehicle-id="${id}"]`)?.closest(".vehicle-row");
      if (row) row.querySelector(".row-status").textContent = "לא נשמר";
      setConnectionState("אין חיבור לענן", "השמירה נכשלה. בדקו את החיבור ונסו שוב.");
    });
  }, 450);
  pendingSaveTimers.set(id, timer);
}

async function refreshCloudData() {
  try {
    const rows = await fetchCloudVehicles();
    applyCloudVehicles(rows);
    setConnectionState("מסונכרן", "הנתונים מסתנכרנים בין המכשירים", true);
  } catch {
    setConnectionState("אין חיבור לענן", "לא ניתן לרענן כרגע את הנתונים המשותפים.");
  }
}

async function initializeCloud() {
  if (!isCloudConfigured()) {
    setConnectionState("נדרש חיבור לענן", "הגדירו את פרטי Supabase בקובץ config.js כדי להתחיל.");
    renderVehicles();
    return;
  }

  setConnectionState("מתחבר לענן", "מתחבר לאחסון המשותף...");
  try {
    let rows = await fetchCloudVehicles();
    if (rows.length === 0) {
      vehicles = loadLocalVehicles();
      await saveCloudVehicles(vehicles);
      rows = vehicles.map(({ id, km }) => ({ id, km: km === "" ? null : km }));
    }
    cloudReady = true;
    applyCloudVehicles(rows);
    renderVehicles();
    updateSummary();
    setConnectionState("מסונכרן", "הנתונים מסתנכרנים בין המכשירים", true);
    window.setInterval(() => {
      if (document.visibilityState === "visible") refreshCloudData();
    }, 8000);
  } catch {
    setConnectionState("החיבור נכשל", "בדקו את פרטי Supabase ואת הגדרת הטבלה.");
  }
}

function updateSummary() {
  const updated = vehicles.filter(({ km }) => km !== "");
  const total = updated.reduce((sum, { km }) => sum + km, 0);
  document.querySelector("#updated-count").textContent = updated.length;
  document.querySelector("#total-km").textContent = updated.length ? formatNumber(total) : "—";
  document.querySelector("#progress-fill").style.width = `${(updated.length / VEHICLE_COUNT) * 100}%`;
  document.querySelector("#progress-copy").textContent = updated.length ? `${updated.length} מתוך ${VEHICLE_COUNT}` : "עדיין אין עדכונים";
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function exportCsv() {
  const rows = [["מספר רכב", "קילומטראז׳"], ...vehicles.map(({ id, km }) => [id, km === "" ? "" : km])];
  const csv = `\uFEFF${rows.map((row) => row.join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "kilometer-fleet.csv";
  link.click();
  URL.revokeObjectURL(url);
  showToast("קובץ הנתונים ירד למכשיר");
}

searchInput.addEventListener("input", renderVehicles);
document.querySelector("#export-button").addEventListener("click", exportCsv);
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
});
document.querySelector("#footer-date").textContent = new Intl.DateTimeFormat("he-IL", { dateStyle: "long" }).format(new Date());

updateSummary();
renderVehicles();
initializeCloud();