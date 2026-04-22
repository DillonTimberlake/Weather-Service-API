/**
 * Weather Forecast HTTP Server
 * Uses the National Weather Service (NWS) API to serve forecasts.
 * Generated with Claude's code generation capabilities.
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

// -------------------------------------------------------------------
// Temperature thresholds (°F)
// -------------------------------------------------------------------
const COLD_MAX = 50; // <= 50 °F → "cold"
const HOT_MIN = 90;  // >= 90 °F → "hot"
                     // between  → "moderate"

function characterizeTemperature(tempF) {
  if (tempF <= COLD_MAX) return "cold";
  if (tempF >= HOT_MIN)  return "hot";
  return "moderate";
}

// -------------------------------------------------------------------
// NWS API helpers
// -------------------------------------------------------------------
const NWS_BASE = "https://api.weather.gov";
const NWS_HEADERS = {
  "User-Agent": "WeatherForecastServer/1.0 (contact@example.com)",
  "Accept": "application/geo+json",
};

/** Fetch a URL and return parsed JSON. Rejects with an enriched Error. */
function nwsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: NWS_HEADERS }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`NWS HTTP ${res.statusCode} for ${url}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`Failed to parse NWS response: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("NWS request timed out"));
    });
  });
}

/**
 * Two-step NWS lookup:
 *   1. /points/{lat},{lon}  → forecast grid URL
 *   2. forecast grid URL    → periods array
 * Returns the "Today" period (or first daytime period as fallback).
 */
async function getForecast(lat, lon) {
  // Step 1 – resolve grid point
  const pointsData = await nwsGet(
    `${NWS_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`
  );
  const forecastUrl = pointsData?.properties?.forecast;
  if (!forecastUrl) throw new Error("NWS response missing forecast URL");

  // Step 2 – fetch forecast periods
  const forecastData = await nwsGet(forecastUrl);
  const periods = forecastData?.properties?.periods;
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error("NWS response contained no forecast periods");
  }

  // Prefer the period explicitly named "Today"; fall back to first daytime period
  const todayPeriod =
    periods.find((p) => p.name?.toLowerCase() === "today") ??
    periods.find((p) => p.isDaytime === true) ??
    periods[0];

  const temp      = todayPeriod.temperature;
  const tempUnit  = todayPeriod.temperatureUnit; // "F" or "C"
  const tempF     = tempUnit === "F" ? temp : temp * 9 / 5 + 32;

  return {
    period_name: todayPeriod.name,
    short_forecast: todayPeriod.shortForecast,
    temperature: temp,
    temperature_unit: tempUnit,
    temperature_characterization: characterizeTemperature(tempF),
  };
}

// -------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------
function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// -------------------------------------------------------------------
// Request handler
// -------------------------------------------------------------------
async function handleRequest(req, res) {
  const base = `http://${req.headers.host}`;
  const { pathname, searchParams } = new URL(req.url, base);

  if (pathname !== "/forecast") {
    return sendJSON(res, 404, {
      error: 'Not found. Use GET /forecast?lat=<lat>&lon=<lon>',
    });
  }

  // Validate query params
  const rawLat = searchParams.get("lat");
  const rawLon = searchParams.get("lon");

  if (rawLat === null || rawLon === null) {
    return sendJSON(res, 400, {
      error: "Missing required query parameters: lat, lon",
    });
  }

  const lat = Number(rawLat);
  const lon = Number(rawLon);

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return sendJSON(res, 400, { error: "lat and lon must be numeric values" });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return sendJSON(res, 400, {
      error: "lat must be between -90 and 90; lon between -180 and 180",
    });
  }

  // Fetch from NWS
  try {
    const result = await getForecast(lat, lon);
    return sendJSON(res, 200, result);
  } catch (err) {
    if (err.statusCode === 404) {
      return sendJSON(res, 502, {
        error: "NWS API returned 404 – coordinates may be outside US coverage",
      });
    }
    if (err.statusCode) {
      return sendJSON(res, 502, {
        error: `NWS API error: HTTP ${err.statusCode}`,
      });
    }
    console.error("Upstream error:", err.message);
    return sendJSON(res, 502, { error: `Upstream error: ${err.message}` });
  }
}

// -------------------------------------------------------------------
// Start server
// -------------------------------------------------------------------
const PORT = parseInt(process.argv[2], 10) || 8000;

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("Unhandled error:", err);
    sendJSON(res, 500, { error: "Internal server error" });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Weather Forecast Server running on http://0.0.0.0:${PORT}`);
  console.log(`  Example: http://localhost:${PORT}/forecast?lat=38.8977&lon=-77.0365`);
  console.log("Press Ctrl+C to stop.\n");
});