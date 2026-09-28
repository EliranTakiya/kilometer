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
  return Array.from({ length: VEHICLE_COUNT }, (_, index) => ({ id: index + 1, plateNumber: "", km: "", kmUpdatedAt: null }));
}

function loadLocalVehicles() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return Array.from({ length: VEHICLE_COUNT }, (_, index) => {
      const id = index + 1;
      const value = saved[id];
      const km = typeof value === "object" && value !== null ? value.km : value;
      return {
        id,
        plateNumber: typeof value?.plateNumber === "string" ? value.plateNumber : "",
        km: Number.isFinite(km) && km >= 0 ? km : "",
        kmUpdatedAt: null
      };
    });
  } catch {
    return Array.from({ length: VEHICLE_COUNT }, (_, index) => ({ id: index + 1, km: "" }));
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat("he-IL").format(value);
}

function formatMileageInput(value) {
  if (value === "") return "";
  const digits = String(value).replace(/\D/g, "");
  return digits ? formatNumber(Number(digits)) : "";
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function renderVehicles() {
  const query = searchInput.value.trim();
  const filtered = vehicles.filter(({ id, plateNumber }) => String(id).includes(query) || plateNumber.includes(query));
  vehicleList.replaceChildren();

  filtered.forEach(({ id, plateNumber, km, kmUpdatedAt }, index) => {
    const row = document.createElement("div");
    row.className = `vehicle-row${km !== "" ? " is-updated" : ""}`;
    row.style.animationDelay = `${Math.min(index, 8) * 18}ms`;

    const identity = document.createElement("div");
    identity.className = "vehicle-id";
    const number = document.createElement("span");
    number.className = "vehicle-number";
    number.textContent = String(id).padStart(2, "0");
    const plateInput = document.createElement("input");
    plateInput.className = "plate-input";
    plateInput.type = "text";
    plateInput.maxLength = 20;
    plateInput.autocomplete = "off";
    plateInput.placeholder = "הזינו מספר רכב";
    plateInput.value = plateNumber;
    plateInput.dataset.vehicleId = id;
    plateInput.disabled = !cloudReady;
    plateInput.setAttribute("aria-label", `מספר רכב ${id}`);
    plateInput.addEventListener("input", () => updatePlateNumber(id, plateInput.value));
    identity.append(number, plateInput);

    const field = document.createElement("label");
    field.className = "km-field";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.dataset.vehicleId = id;
    input.disabled = !cloudReady;
    input.placeholder = "הקלידו קילומטראז׳";
    input.setAttribute("aria-label", `קילומטראז׳ נוכחי, רכב ${id}`);
    input.value = formatMileageInput(km);
    input.addEventListener("input", () => {
      const digitCountBeforeCaret = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, "").length;
      const digits = input.value.replace(/\D/g, "");
      input.value = formatMileageInput(digits);
      let caret = 0;
      let countedDigits = 0;
      while (caret < input.value.length && countedDigits < digitCountBeforeCaret) {
        if (/\d/.test(input.value[caret])) countedDigits += 1;
        caret += 1;
      }
      input.setSelectionRange(caret, caret);
      updateMileage(id, digits);
    });
    const unit = document.createElement("span");
    unit.textContent = "ק״מ";
    field.append(input, unit);

    const status = document.createElement("span");
    status.className = "row-status";
    status.textContent = !cloudReady ? "לא מחובר" : km === "" ? "ממתין לעדכון" : "עודכן";
    const updatedCell = document.createElement("div");
    updatedCell.className = "updated-cell";
    const updatedTime = document.createElement("time");
    updatedTime.className = "updated-time";
    updatedTime.textContent = formatDateTime(kmUpdatedAt);
    if (kmUpdatedAt) updatedTime.dateTime = kmUpdatedAt;
    updatedCell.append(updatedTime, status);
    row.append(identity, field, updatedCell);
    vehicleList.append(row);
  });

  emptyState.hidden = filtered.length !== 0;
  document.querySelector("#list-count").textContent = `${filtered.length} רכבים`;
}

function updateMileage(id, rawValue) {
  const digits = rawValue.replace(/\D/g, "");
  const parsed = digits === "" ? "" : Number(digits);
  if (!cloudReady || (parsed !== "" && (!Number.isFinite(parsed) || parsed < 0))) return;

  vehicles = vehicles.map((vehicle) => vehicle.id === id ? { ...vehicle, km: parsed } : vehicle);
  updateSummary();

  const row = vehicleList.querySelector(`[data-vehicle-id="${id}"]`)?.closest(".vehicle-row");
  if (row) {
    row.querySelector(".row-status").textContent = "שומר...";
  }
  scheduleMileageSave(id);
}

function updatePlateNumber(id, value) {
  if (!cloudReady) return;
  vehicles = vehicles.map((vehicle) => vehicle.id === id ? { ...vehicle, plateNumber: value.trimStart() } : vehicle);
  scheduleMileageSave(id);
  const row = vehicleList.querySelector(`[data-vehicle-id="${id}"]`)?.closest(".vehicle-row");
  if (row) row.querySelector(".row-status").textContent = "שומר...";
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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/vehicle_mileage?select=id,plate_number,km,km_updated_at`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Could not load mileage (${response.status})`);
  return response.json();
}

async function saveCloudVehicles(records) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/vehicle_mileage?on_conflict=id`, {
    method: "POST",
    headers: supabaseHeaders("resolution=merge-duplicates,return=representation"),
    body: JSON.stringify(records.map(({ id, plateNumber, km }) => ({ id, plate_number: plateNumber, km: km === "" ? null : km })))
  });
  if (!response.ok) throw new Error(`Could not save mileage (${response.status})`);
  return response.json();
}

function normalizeCloudMileage(value) {
  if (value === null || value === undefined) return "";
  const mileage = Number(value);
  return Number.isFinite(mileage) && mileage >= 0 ? mileage : "";
}

function applyCloudVehicles(rows) {
  const cloudValues = new Map(rows.map(({ id, plate_number, km, km_updated_at }) => [Number(id), {
    plateNumber: typeof plate_number === "string" ? plate_number : "",
    km: normalizeCloudMileage(km),
    kmUpdatedAt: km_updated_at || null
  }]));
  const focusedId = Number(document.activeElement?.dataset?.vehicleId);
  vehicles = vehicles.map((vehicle) => {
    if (pendingSaveTimers.has(vehicle.id) || saveQueues.has(vehicle.id) || vehicle.id === focusedId) return vehicle;
    return { ...vehicle, ...(cloudValues.get(vehicle.id) || { plateNumber: "", km: "", kmUpdatedAt: null }) };
  });

  vehicles.forEach(({ id, plateNumber, km, kmUpdatedAt }) => {
    const plateInput = vehicleList.querySelector(`.plate-input[data-vehicle-id="${id}"]`);
    const mileageInput = vehicleList.querySelector(`.km-field input[data-vehicle-id="${id}"]`);
    if (!plateInput || !mileageInput) return;
    plateInput.value = plateNumber;
    mileageInput.value = formatMileageInput(km);
    const row = mileageInput.closest(".vehicle-row");
    row.classList.toggle("is-updated", km !== "");
    row.querySelector(".updated-time").textContent = formatDateTime(kmUpdatedAt);
    if (kmUpdatedAt) row.querySelector(".updated-time").dateTime = kmUpdatedAt;
    else row.querySelector(".updated-time").removeAttribute("datetime");
    row.querySelector(".row-status").textContent = km === "" ? "ממתין לעדכון" : "עודכן";
  });
  updateSummary();
}

function scheduleMileageSave(id) {
  clearTimeout(pendingSaveTimers.get(id));
  const timer = setTimeout(() => {
    pendingSaveTimers.delete(id);
    const record = { ...vehicles.find((vehicle) => vehicle.id === id) };
    const previousSave = saveQueues.get(id) || Promise.resolve();
    const currentSave = previousSave.catch(() => {}).then(() => saveCloudVehicles([record]));
    saveQueues.set(id, currentSave);

    currentSave.then((savedRows) => {
      if (saveQueues.get(id) !== currentSave) return;
      saveQueues.delete(id);
      const saved = savedRows.find((item) => Number(item.id) === id);
      if (saved) {
        vehicles = vehicles.map((vehicle) => vehicle.id === id && vehicle.km === record.km && vehicle.plateNumber === record.plateNumber
          ? { ...vehicle, kmUpdatedAt: saved.km_updated_at || null }
          : vehicle);
      }
      const row = vehicleList.querySelector(`[data-vehicle-id="${id}"]`)?.closest(".vehicle-row");
      if (row) {
        const current = vehicles.find((vehicle) => vehicle.id === id);
        row.classList.toggle("is-updated", record.km !== "");
        row.querySelector(".updated-time").textContent = formatDateTime(current.kmUpdatedAt);
        if (current.kmUpdatedAt) row.querySelector(".updated-time").dateTime = current.kmUpdatedAt;
        else row.querySelector(".updated-time").removeAttribute("datetime");
        row.querySelector(".row-status").textContent = current.km === "" ? "ממתין לעדכון" : "עודכן";
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
      rows = await saveCloudVehicles(vehicles);
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
  const weekInMilliseconds = 7 * 24 * 60 * 60 * 1000;
  const pending = vehicles.filter(({ kmUpdatedAt }) => {
    if (!kmUpdatedAt) return true;
    const updatedAt = new Date(kmUpdatedAt).getTime();
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt > weekInMilliseconds;
  });
  document.querySelector("#updated-count").textContent = updated.length;
  document.querySelector("#pending-count").textContent = pending.length;
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
  const rows = [["מספר פנימי", "מספר רכב", "קילומטראז׳", "עדכון אחרון"], ...vehicles.map(({ id, plateNumber, km, kmUpdatedAt }) => [id, plateNumber, km === "" ? "" : km, formatDateTime(kmUpdatedAt)])];
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