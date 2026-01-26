# ATC-Drone Control Center

Web-based mission control interface for the ATC-Drone UTM (Unmanned Traffic Management) system. Provides real-time 3D visualization of drone fleet operations, conflict detection, and airspace management.

## Features

- **Live 3D Map** - CesiumJS with Google Photorealistic 3D tiles for real-time drone tracking
- **Fleet Management** - Register, monitor, and command drones (HOLD, RESUME, LAND)
- **Conflict Detection** - Visual alerts when drones violate separation minimums
- **Geofencing** - Define and visualize no-fly zones, restricted areas, and temporary restrictions
- **Mission Planning** - Create flight plans with waypoints and altitude profiles
- **Analytics Dashboard** - Flight statistics, conflict history, fleet performance
- **User Authentication** - Signup/login with session-based auth

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Control Center │────▶│   ATC Server    │◀────│   Drone SDK     │
│   (This Repo)   │     │ (atc-drone/Rust)│     │ (atc-sdk/Rust)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
     Port 5050              Port 3000            Runs on drones
```

## Quick Start

### Prerequisites
- Docker & Docker Compose
- ATC Server running on `localhost:3000`
  - If `/v1/drones/register` is locked down, set `ATC_REGISTRATION_TOKEN` to match the ATC server.

### Run with Docker

```bash
docker compose up -d
```

Access at: http://localhost:5050

### Bootstrap Users
Set these in `.env` (or container env) to seed the first admin account:
- `ATC_BOOTSTRAP_ADMIN_EMAIL`
- `ATC_BOOTSTRAP_ADMIN_PASSWORD`
- Optional: `ATC_BOOTSTRAP_ADMIN_ID`, `ATC_BOOTSTRAP_ADMIN_NAME`

For local demos only, you can allow the legacy defaults by setting:
- `ATC_ALLOW_DEFAULT_USERS=1` (seeds `admin` and `guest`)

## Project Structure

```
├── views/                 # EJS templates
│   ├── dashboard.ejs      # Main dashboard
│   ├── map.ejs            # Live 3D map
│   ├── fleet.ejs          # Drone list
│   ├── missions.ejs       # Mission management
│   ├── geofences.ejs      # Geofence management
│   ├── conflicts.ejs      # Conflict alerts
│   ├── analytics.ejs      # Charts & stats
│   └── settings.ejs       # User settings
├── static/
│   ├── js/                # Frontend JavaScript
│   │   ├── map.js         # Cesium 3D map logic
│   │   ├── geofences.js   # Geofence visualization
│   │   ├── api-client.js  # ATC server API client
│   │   └── route-planner.js # Server-backed A* routing
│   ├── css/               # Stylesheets
│   └── planner/           # 🛩️ Flight Planner Module
│       ├── index.html     # Planner UI
│       └── src/
│           ├── planner.js     # Core planner logic
├── routes/
│   └── control.js         # Express routes
└── server.js              # Main server entry
```

---

## 🛩️ Flight Planner Module

**Location:** `static/planner/`

A 3D drone flight path planner with FAA-compliant route validation.

### Features

| Feature | Description |
|---------|-------------|
| **Google Maps-Style UI** | Start/Stop/Destination inputs with geocoding |
| **A* Pathfinding** | Terrain-following routes that clear buildings |
| **String Pulling** | Smooths grid paths into direct flight segments |
| **Safety Corridor** | 3D tube visualization (8m operational zone) |
| **4D Trajectory** | 1m-spaced waypoints with time offsets |
| **FAA Validation** | Part 107 altitude compliance (< 400ft AGL) |

### Quick Start

1. Navigate to `http://localhost:5050/control/flight-planner`
2. Type start address → Press Enter → Geocodes & flies to location
3. Type destination → Press Enter → Adds waypoint
4. Click "Calculate Route" → A* finds optimal path
5. Click "Submit Flight Plan" → Sends to ATC server

### ATC Integration Payload

```json
{
  "flight_id": "uuid",
  "waypoints": [...],           // Sparse key waypoints (12 points)
  "trajectory_log": [...],      // Dense 1m trajectory (1500+ points)
  "metadata": { "faa_compliant": true, "trajectory_points": 1523 }
}
```

### Configuration

| File | Key Settings |
|------|--------------|
| `planner.js` | `SAFETY_BUFFER_M: 20`, `FAA_MAX_ALTITUDE: 121` |
| `route-planner.js` | Calls `/v1/routes/plan` for A* routing |

Runtime overrides:
- `ATC_ROUTE_PLANNER_CONFIG` (JSON) to override planner constants

---

## SDK Documentation

Visit `/docs` for the drone integration SDK documentation, including:
- Quick start guide
- API reference
- Code examples

## Related Repositories

- **[atc-drone](https://github.com/ezrakhuzadi/atc-drone)** - Rust backend server and SDK

## Tech Stack

- **Frontend:** Node.js, Express, EJS, CesiumJS, Chart.js
- **3D Tiles:** Google Photorealistic 3D Tiles via Cesium Ion
- **Backend:** Connects to ATC Server (Rust/Axum)
- **Planner:** CesiumJS + OSM Buildings + A* Pathfinding

## Development Status

| Module | Status |
|--------|--------|
| Control Center | 🟢 Active |
| Flight Planner | 🟢 Active - Route UX & ATC Integration |
| ATC Server | 🟢 Active |

## License

Apache 2.0
