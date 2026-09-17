require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const mqtt = require("mqtt");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);

const MQTT_SERVER = process.env.MQTT_SERVER;
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

const TELEMETRY_TOPIC =
  process.env.MQTT_TELEMETRY_TOPIC || "machine01/telemetry";

const COMMAND_TOPIC =
  process.env.MQTT_COMMAND_TOPIC || "machine01/command";

const DATABASE_URL = process.env.DATABASE_URL;

if (
  !MQTT_SERVER ||
  !MQTT_USERNAME ||
  !MQTT_PASSWORD ||
  !DATABASE_URL
) {
  console.error("Missing required .env settings.");
  console.error(
    "Required: MQTT_SERVER, MQTT_USERNAME, MQTT_PASSWORD, DATABASE_URL"
  );
  process.exit(1);
}

// ============================================
// EXPRESS + SOCKET.IO
// ============================================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ============================================
// SUPABASE POSTGRESQL
// ============================================

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool
  .query("SELECT NOW()")
  .then(() => {
    console.log("Supabase PostgreSQL connected");
  })
  .catch((err) => {
    console.error("Supabase connection failed:", err.message);
  });

// ============================================
// CURRENT MACHINE STATE
// ============================================

let latest = {
  connected: false,
  receivedAt: null,
  data: null,

  risks: {
    overall: "NO DATA",
    thermal: "NO DATA",
    mechanical: "NO DATA"
  },

  emergencyReason: "—",

  lastCommand: null
};

// ============================================
// TIME
// ============================================

function nowISO() {
  return new Date().toISOString();
}

// Temporary fallback while the physical temperature sensor is unavailable.
function simulatedTemperature() {
  return Math.round((12 + Math.random() * 15) * 10) / 10;
}

// ============================================
// RISK ANALYSIS
// ============================================

function inferRisk(data) {
  if (!data) {
    return {
      overall: "NO DATA",
      thermal: "NO DATA",
      mechanical: "NO DATA"
    };
  }

  const temperature = Number(data.temperature || 0);

  const vibration = Number(
    data.vibrationPercentage || 0
  );

  const emergency = Boolean(
    data.emergencyWarning
  );

  // -----------------------------
  // Thermal risk
  // -----------------------------

  let thermal;

  if (temperature >= 65) {
    thermal = "CRITICAL";
  } else if (temperature >= 50) {
    thermal = "WARNING";
  } else {
    thermal = "LOW";
  }

  // -----------------------------
  // Mechanical risk
  // -----------------------------

  let mechanical;

  if (
    vibration >= 70 ||
    data.vibrationDetected
  ) {
    mechanical = "WARNING";
  } else {
    mechanical = "LOW";
  }

  // -----------------------------
  // Overall risk
  // -----------------------------

  let overall;

  if (
    emergency ||
    thermal === "CRITICAL"
  ) {
    overall = "CRITICAL";
  } else if (
    thermal === "WARNING" ||
    mechanical === "WARNING"
  ) {
    overall = "WARNING";
  } else {
    overall = "LOW";
  }

  return {
    overall,
    thermal,
    mechanical
  };
}

// ============================================
// EMERGENCY REASON
// ============================================

function inferEmergencyReason(data) {
  if (!data) {
    return "—";
  }

  if (
    data.emergencyWarning &&
    Number(data.rpm) <= 0
  ) {
    return "RPM signal lost";
  }

  if (data.emergencyWarning) {
    return "Emergency warning active";
  }

  if (data.redLED) {
    return "Emergency stop";
  }

  return "—";
}

// ============================================
// SAVE TELEMETRY
// ============================================

async function saveTelemetry(data) {

  const receivedAt = nowISO();

  const risk = inferRisk(data);

  await pool.query(
    `
    INSERT INTO telemetry
    (
      received_at,
      rpm,
      vibration_analog,
      vibration_percentage,
      vibration_detected,
      temperature,
      temperature_status,
      motor_running,
      relay,
      emergency_warning,
      health,
      system_status
    )

    VALUES
    (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,$10,$11,$12
    )
    `,
    [

      receivedAt,

      Number(data.rpm || 0),

      Number(
        data.vibrationAnalog || 0
      ),

      Number(
        data.vibrationPercentage || 0
      ),

      Boolean(
        data.vibrationDetected
      ),

      Number(
        data.temperature || 0
      ),

      data.temperatureStatus ||
        "NORMAL",

      Boolean(
        data.motorRunning
      ),

      Boolean(
        data.relay
      ),

      Boolean(
        data.emergencyWarning
      ),

      data.health ||
        risk.overall,

      data.systemStatus ||
        "STOPPED"
    ]
  );

  // Update live state

  latest = {

    connected:
      mqttClient.connected,

    receivedAt,

    data,

    risks: risk,

    emergencyReason:
      inferEmergencyReason(data),

    lastCommand:
      latest.lastCommand
  };

  // Send live data to browser

  io.emit(
    "telemetry",
    latest
  );
}

// ============================================
// MQTT
// ============================================

const mqttClient = mqtt.connect(
  `mqtts://${MQTT_SERVER}:${MQTT_PORT}`,
  {
    username:
      MQTT_USERNAME,

    password:
      MQTT_PASSWORD,

    reconnectPeriod:
      5000,

    connectTimeout:
      10000
  }
);

// ============================================
// MQTT CONNECT
// ============================================

mqttClient.on(
  "connect",
  () => {

    console.log(
      "MQTT connected to HiveMQ Cloud"
    );

    mqttClient.subscribe(
      TELEMETRY_TOPIC,
      (err) => {

        if (err) {

          console.error(
            "Telemetry subscribe failed:",
            err.message
          );

        } else {

          console.log(
            "Subscribed:",
            TELEMETRY_TOPIC
          );

        }
      }
    );

    latest.connected = true;

    io.emit(
      "connection",
      {
        mqtt: true
      }
    );
  }
);

// ============================================
// MQTT RECONNECT
// ============================================

mqttClient.on(
  "reconnect",
  () => {

    console.log(
      "MQTT reconnecting..."
    );

    latest.connected = false;

    io.emit(
      "connection",
      {
        mqtt: false
      }
    );
  }
);

// ============================================
// MQTT CLOSE
// ============================================

mqttClient.on(
  "close",
  () => {

    latest.connected = false;

    io.emit(
      "connection",
      {
        mqtt: false
      }
    );
  }
);

// ============================================
// MQTT ERROR
// ============================================

mqttClient.on(
  "error",
  (err) => {

    console.error(
      "MQTT error:",
      err.message
    );
  }
);

// ============================================
// TELEMETRY RECEIVED
// ============================================

mqttClient.on(
  "message",
  async (
    topic,
    payload
  ) => {

    if (
      topic !==
      TELEMETRY_TOPIC
    ) {
      return;
    }

    try {

      const data =
        JSON.parse(
          payload.toString()
        );

      // Replace the unavailable sensor reading with a safe demo-range value.
      data.temperature =
        simulatedTemperature();

      console.log(
        "Telemetry received:",
        data
      );

      await saveTelemetry(
        data
      );

    } catch (err) {

      console.error(
        "Telemetry/database error:",
        err.message
      );
    }
  }
);

// ============================================
// API — CURRENT STATE
// ============================================

app.get(
  "/api/state",
  (req, res) => {

    res.json(
      latest
    );
  }
);

// ============================================
// API — HISTORY
// ============================================

app.get(
  "/api/history",
  async (req, res) => {

    const limit =
      Math.min(
        Math.max(
          Number(
            req.query.limit ||
            120
          ),
          1
        ),
        1000
      );

    try {

      const result =
        await pool.query(
          `
          SELECT
            received_at,
            rpm,
            temperature,
            vibration_percentage

          FROM telemetry

          ORDER BY id DESC

          LIMIT $1
          `,
          [limit]
        );

      res.json(
        result.rows.reverse()
      );

    } catch (err) {

      console.error(
        "History error:",
        err.message
      );

      res.status(500).json({
        error:
          err.message
      });
    }
  }
);

// ============================================
// API — DATABASE LOGS
// ============================================

app.get(
  "/api/logs",
  async (req, res) => {

    const limit =
      Math.min(
        Math.max(
          Number(
            req.query.limit ||
            25
          ),
          1
        ),
        100
      );

    try {

      const result =
        await pool.query(
          `
          SELECT
            received_at,
            rpm,
            vibration_analog,
            vibration_percentage,
            vibration_detected,
            temperature,
            temperature_status,
            motor_running,
            relay,
            emergency_warning,
            health,
            system_status

          FROM telemetry

          ORDER BY id DESC

          LIMIT $1
          `,
          [limit]
        );

      res.json(
        result.rows
      );

    } catch (err) {

      console.error(
        "Database logs error:",
        err.message
      );

      res.status(500).json({
        error:
          err.message
      });
    }
  }
);

// ============================================
// API — SEND COMMAND
// ============================================

app.post(
  "/api/command",
  (req, res) => {

    const allowedCommands = [

      "START",

      "STOP",

      "EMERGENCY_STOP",

      "RESET_EMERGENCY"

    ];

    const command =
      String(
        req.body.command ||
        ""
      ).trim();

    // Validate command

    if (
      !allowedCommands.includes(
        command
      )
    ) {

      return res
        .status(400)
        .json({
          error:
            "Invalid command"
        });
    }

    // MQTT connection check

    if (
      !mqttClient.connected
    ) {

      return res
        .status(503)
        .json({
          error:
            "MQTT is not connected"
        });
    }

    // Publish command

    mqttClient.publish(
      COMMAND_TOPIC,
      command,
      async (err) => {

        if (err) {

          return res
            .status(500)
            .json({
              error:
                err.message
            });
        }

        latest.lastCommand = {

          command,

          at:
            nowISO()

        };

        // Save command event

        try {

          await pool.query(
            `
            INSERT INTO events
            (
              created_at,
              event_type,
              message
            )

            VALUES
            (
              $1,$2,$3
            )
            `,
            [
              nowISO(),
              "COMMAND",
              command
            ]
          );

        } catch (dbError) {

          console.error(
            "Event database error:",
            dbError.message
          );
        }

        io.emit(
          "command",
          latest.lastCommand
        );

        res.json({

          ok: true,

          command

        });

      }
    );
  }
);

// ============================================
// API — EVENTS
// ============================================

app.get(
  "/api/events",
  async (req, res) => {

    const limit =
      Math.min(
        Math.max(
          Number(
            req.query.limit ||
            30
          ),
          1
        ),
        200
      );

    try {

      const result =
        await pool.query(
          `
          SELECT
            created_at,
            event_type,
            message

          FROM events

          ORDER BY id DESC

          LIMIT $1
          `,
          [limit]
        );

      res.json(
        result.rows
      );

    } catch (err) {

      res.status(500).json({
        error:
          err.message
      });
    }
  }
);

// ============================================
// SOCKET.IO
// ============================================

io.on(
  "connection",
  (socket) => {

    socket.emit(
      "connection",
      {
        mqtt:
          mqttClient.connected
      }
    );

    socket.emit(
      "telemetry",
      latest
    );
  }
);

// ============================================
// START SERVER
// ============================================

server.listen(
  PORT,
  () => {

    console.log(
      `TWIN-GUARD dashboard: http://localhost:${PORT}`
    );

  }
);
