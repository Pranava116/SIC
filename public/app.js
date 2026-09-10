const socket = io();

let latestState = null;
let chart;

const $ = (id) => document.getElementById(id);

function setClass(el, cls) {
  el.className = cls;
}

function showToast(message) {
  const t = $("toast");
  t.textContent = message;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function showView(view) {
  const showingLogs = view === "logs";
  $("dashboardView").hidden = showingLogs;
  $("logsView").hidden = !showingLogs;

  document.querySelectorAll(".nav-button").forEach((button) => {
    const isActive = button.dataset.view === view;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  });

  if (showingLogs) loadDatabaseLogs();
}

function updateMQTT(online) {
  $("mqttText").textContent = online ? "MQTT ONLINE" : "MQTT OFFLINE";
  $("mqttStatus2").textContent = online ? "CONNECTED" : "OFFLINE";
  $("mqttDot").className = "dot " + (online ? "online" : "offline");
}

function updateUI(state) {
  if (!state) return;
  latestState = state;
  updateMQTT(Boolean(state.connected));

  const d = state.data;
  if (!d) return;

  const rpm = Number(d.rpm || 0);
  const temp = Number(d.temperature || 0);
  const vib = Number(d.vibrationPercentage || 0);

  $("rpm").textContent = Math.round(rpm);
  $("rpmCard").textContent = Math.round(rpm);
  $("temp").textContent = temp.toFixed(1);
  $("vibration").textContent = vib.toFixed(1);

  $("relay").textContent = d.relay ? "ON" : "OFF";
  $("motorState").textContent = d.motorRunning ? "RUNNING" : "STOPPED";
  setClass($("motorState"), "big-state " + (d.motorRunning ? "running" : "stopped"));

  $("health").textContent = d.health || state.risks?.overall || "NO DATA";
  $("overallRisk").textContent = state.risks?.overall || "NO DATA";
  $("thermalRisk").textContent = state.risks?.thermal || "NO DATA";
  $("mechanicalRisk").textContent = state.risks?.mechanical || "NO DATA";

  $("tempStatus").textContent = d.temperatureStatus || "NO DATA";
  $("vibrationStatus").textContent = d.vibrationDetected ? "DETECTED" : "NO DIGITAL ALERT";

  const emergency = Boolean(d.emergencyWarning) || Boolean(d.redLED);
  $("emergencyState").textContent = emergency
    ? (d.emergencyWarning ? "EMERGENCY WARNING" : "EMERGENCY STOP")
    : "NORMAL";
  $("emergencyState").className = emergency ? "emergency-active" : "emergency-normal";
  $("emergencyReason").textContent = state.emergencyReason || "—";

  $("telemetryStatus").textContent = "RECEIVING";
  $("lastUpdate").textContent = state.receivedAt
    ? new Date(state.receivedAt).toLocaleTimeString()
    : "—";

  if (state.lastCommand) {
    $("lastCommand").textContent = state.lastCommand.command;
  }
}

async function sendCommand(command) {
  try {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Command failed");
    showToast("Command sent: " + command);
  } catch (err) {
    showToast(err.message);
  }
}

function initChart() {
  const ctx = $("trendChart").getContext("2d");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "RPM", data: [], borderWidth: 2, tension: .25, yAxisID: "rpm" },
        { label: "Temperature °C", data: [], borderWidth: 2, tension: .25, yAxisID: "value" },
        { label: "Vibration %", data: [], borderWidth: 2, tension: .25, yAxisID: "value" }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        rpm: { position: "left", beginAtZero: true, grid: { color: "#202a35" } },
        value: { position: "right", beginAtZero: true, max: 100, grid: { drawOnChartArea: false } }
      },
      plugins: { legend: { labels: { color: "#aab6c2" } } }
    }
  });
}

async function loadHistory() {
  try {
    const rows = await fetch("/api/history?limit=80").then(r => r.json());
    chart.data.labels = rows.map(x => new Date(x.received_at).toLocaleTimeString());
    chart.data.datasets[0].data = rows.map(x => x.rpm);
    chart.data.datasets[1].data = rows.map(x => x.temperature);
    chart.data.datasets[2].data = rows.map(x => x.vibration_percentage);
    chart.update();
  } catch (e) {
    console.error(e);
  }
}

async function loadEvents() {
  try {
    const rows = await fetch("/api/events?limit=20").then(r => r.json());
    $("events").innerHTML = rows.length
      ? rows.map(x => `<div class="event"><time>${new Date(x.created_at).toLocaleString()}</time><b>${x.event_type}</b><span>${x.message}</span></div>`).join("")
      : "No events yet.";
  } catch (e) {
    console.error(e);
  }
}

function createLogCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

function renderDatabaseLogs(rows) {
  const body = $("databaseLogs");
  body.replaceChildren();

  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = createLogCell("No database logs yet.");
    cell.colSpan = 8;
    cell.className = "logs-empty";
    row.append(cell);
    body.append(row);
    return;
  }

  rows.forEach((log) => {
    const row = document.createElement("tr");
    row.append(
      createLogCell(new Date(log.received_at).toLocaleString()),
      createLogCell(Math.round(Number(log.rpm || 0))),
      createLogCell(`${Number(log.temperature || 0).toFixed(1)} °C`),
      createLogCell(`${Number(log.vibration_percentage || 0).toFixed(1)}%`),
      createLogCell(log.motor_running ? "RUNNING" : "STOPPED"),
      createLogCell(log.relay ? "ON" : "OFF"),
      createLogCell(log.health || "—"),
      createLogCell(log.system_status || log.temperature_status || "—")
    );
    body.append(row);
  });
}

async function loadDatabaseLogs() {
  const refreshStatus = $("logsRefreshStatus");

  try {
    const response = await fetch("/api/logs?limit=25");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load database logs");

    renderDatabaseLogs(result);
    refreshStatus.textContent = `UPDATED ${new Date().toLocaleTimeString()}`;
    refreshStatus.classList.remove("refresh-error");
  } catch (err) {
    console.error(err);
    refreshStatus.textContent = "DATABASE LOGS UNAVAILABLE";
    refreshStatus.classList.add("refresh-error");
  }
}

function updateFreshness() {
  if (!latestState?.receivedAt) return;
  const seconds = Math.max(0, (Date.now() - new Date(latestState.receivedAt).getTime()) / 1000);
  $("freshness").textContent = seconds.toFixed(0);
  $("freshnessStatus").textContent = seconds <= 15 ? "LIVE" : "DATA STALE";
  $("freshnessStatus").className = seconds <= 15 ? "" : "critical";
}

socket.on("connection", (state) => updateMQTT(state.mqtt));
socket.on("telemetry", updateUI);
socket.on("command", (cmd) => {
  $("lastCommand").textContent = cmd.command;
  loadEvents();
});

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

initChart();
loadHistory();
loadEvents();
loadDatabaseLogs();
setInterval(updateFreshness, 1000);
setInterval(loadHistory, 10000);
setInterval(loadEvents, 5000);
setInterval(loadDatabaseLogs, 10000);
