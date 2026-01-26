/**
 * Route Planner - Server-backed route analysis
 * Uses backend routing; frontend only visualizes and hydrates terrain heights.
 */

(function (root) {
    'use strict';

    const CesiumConfig = root.__CESIUM_CONFIG__ || {};
    const ATC_BASE_FALLBACK = '/api/atc';

    function safeParentValue(key) {
        try {
            if (root.parent && root.parent !== root) {
                return root.parent[key];
            }
        } catch (error) {
            return '';
        }
        return '';
    }

    function normalizeAtcBase(value) {
        if (typeof value !== 'string') return '';
        const trimmed = value.trim();
        return trimmed ? trimmed.replace(/\/$/, '') : '';
    }

    function resolveAtcBase() {
        const candidates = [
            root.__ATC_API_BASE__,
            safeParentValue('__ATC_API_BASE__'),
            ATC_BASE_FALLBACK
        ];
        for (const candidate of candidates) {
            const normalized = normalizeAtcBase(candidate);
            if (normalized) return normalized;
        }
        return normalizeAtcBase(ATC_BASE_FALLBACK);
    }

    function joinUrl(base, path) {
        if (!base) return path;
        if (base.endsWith('/') && path.startsWith('/')) {
            return base.slice(0, -1) + path;
        }
        if (!base.endsWith('/') && !path.startsWith('/')) {
            return `${base}/${path}`;
        }
        return base + path;
    }

    const ATC_SERVER_URL = resolveAtcBase();

    const DEFAULTS = Object.assign({
        OSM_BUILDINGS_ASSET_ID: Number(CesiumConfig.osmBuildingsAssetId) || 96188,
        FAA_MAX_ALTITUDE_AGL_M: 121,
        DEFAULT_SAFETY_BUFFER_M: 20,
        DEFAULT_SAMPLE_SPACING_M: 5,
        DEFAULT_LANE_RADIUS_M: 90,
        LANE_SPACING_M: 15,
        LANE_EXPANSION_STEP_M: 100,
        TILESET_LOAD_TIMEOUT_MS: 15000,
        TILESET_POLL_INTERVAL_MS: 200
    }, root.__ROUTE_PLANNER_CONFIG__ || {});

    const state = {
        viewer: null,
        osmTileset: null,
        osmTilesetPromise: null
    };

    function toRad(deg) {
        return deg * Math.PI / 180;
    }

    function calculateDistance(p1, p2) {
        const R = 6371000;
        const phi1 = toRad(p1.lat);
        const phi2 = toRad(p2.lat);
        const dPhi = toRad(p2.lat - p1.lat);
        const dLambda = toRad(p2.lon - p1.lon);
        const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function computeRouteDistance(waypoints) {
        if (!Array.isArray(waypoints) || waypoints.length < 2) return 0;
        let distance = 0;
        for (let i = 1; i < waypoints.length; i += 1) {
            distance += calculateDistance(waypoints[i - 1], waypoints[i]);
        }
        return distance;
    }

    function looksLikeJsonBody(contentType, text) {
        if (contentType && contentType.includes('application/json')) {
            return true;
        }
        if (!text) return false;
        const trimmed = text.trim();
        return trimmed.startsWith('{') || trimmed.startsWith('[');
    }

    function parseJsonBody(contentType, text) {
        if (!looksLikeJsonBody(contentType, text)) {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            return null;
        }
    }

    function extractErrorMessage(data, fallbackText, status) {
        if (data) {
            if (Array.isArray(data.errors) && data.errors.length) {
                const messages = data.errors
                    .map((entry) => {
                        if (typeof entry === 'string') return entry;
                        if (entry && typeof entry.message === 'string') return entry.message;
                        return null;
                    })
                    .filter(Boolean);
                if (messages.length) {
                    return messages.join(', ');
                }
            } else if (typeof data.errors === 'string' && data.errors) {
                return data.errors;
            }
            if (typeof data.error === 'string' && data.error) {
                return data.error;
            }
            if (typeof data.message === 'string' && data.message) {
                return data.message;
            }
        }

        const fallback = (fallbackText || '').trim();
        if (fallback) {
            const looksJson = fallback.startsWith('{') || fallback.startsWith('[');
            if (!looksJson) {
                return fallback;
            }
        }

        const statusLabel = Number.isFinite(status) ? status : 'unknown';
        return `Route plan failed: ${statusLabel}`;
    }

    function normalizeWaypoints(waypoints, defaultAlt) {
        const fallbackAlt = Number.isFinite(defaultAlt) ? defaultAlt : 60;
        return waypoints.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: Number.isFinite(wp.alt) ? wp.alt : fallbackAlt
        }));
    }

    async function requestServerRoute(waypoints, config) {
        const payload = {
            waypoints: waypoints.map((wp) => ({
                lat: wp.lat,
                lon: wp.lon,
                altitude_m: wp.alt
            })),
            lane_radius_m: config.DEFAULT_LANE_RADIUS_M,
            lane_spacing_m: config.LANE_SPACING_M,
            sample_spacing_m: config.DEFAULT_SAMPLE_SPACING_M,
            safety_buffer_m: config.DEFAULT_SAFETY_BUFFER_M,
            lane_expansion_step_m: config.LANE_EXPANSION_STEP_M
        };

        const response = await fetch(joinUrl(ATC_SERVER_URL, '/v1/routes/plan'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const contentType = response.headers.get('content-type') || '';
        const bodyText = await response.text();
        const data = parseJsonBody(contentType, bodyText);

        if (!response.ok || (data && data.ok === false)) {
            const message = extractErrorMessage(data, bodyText, response.status);
            throw new Error(message);
        }

        if (data) {
            return data;
        }

        return {};
    }

    async function applyTerrainToServerWaypoints(waypoints) {
        if (!state.viewer || !Array.isArray(waypoints) || waypoints.length === 0) {
            return waypoints;
        }

        const cartos = waypoints.map((wp) => Cesium.Cartographic.fromDegrees(wp.lon, wp.lat));
        let samples = [];
        try {
            samples = await Cesium.sampleTerrainMostDetailed(state.viewer.terrainProvider, cartos);
        } catch (error) {
            console.warn('[RoutePlanner] Terrain sample failed for server route:', error);
            return waypoints.map((wp) => ({ ...wp, terrainHeight: 0 }));
        }

        return waypoints.map((wp, idx) => {
            const terrainHeight = samples[idx]?.height || 0;
            let alt = wp.alt;
            if (!Number.isFinite(alt)) {
                alt = terrainHeight;
            } else if (Number.isFinite(terrainHeight) && alt < terrainHeight - 1) {
                alt = alt + terrainHeight;
            }

            if (typeof wp.phase === 'string' && wp.phase.startsWith('GROUND')) {
                alt = terrainHeight;
            }

            return { ...wp, alt, terrainHeight };
        });
    }

    async function loadOsmBuildings(config) {
        if (state.osmTileset) return state.osmTileset;
        if (state.osmTilesetPromise) return state.osmTilesetPromise;

        state.osmTilesetPromise = Cesium.Cesium3DTileset.fromIonAssetId(config.OSM_BUILDINGS_ASSET_ID)
            .then((tileset) => {
                state.osmTileset = tileset;
                state.viewer.scene.primitives.add(tileset);
                return tileset;
            })
            .catch((error) => {
                console.warn('[RoutePlanner] OSM Buildings failed to load:', error);
                state.osmTilesetPromise = null;
                return null;
            });

        return state.osmTilesetPromise;
    }

    async function focusCameraOnRoute(waypoints) {
        if (!state.viewer || waypoints.length < 2) return;
        const boundingSphere = Cesium.BoundingSphere.fromPoints(
            waypoints.map((wp) => Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt || 0))
        );

        state.viewer.camera.flyToBoundingSphere(boundingSphere, {
            duration: 0.8,
            offset: new Cesium.HeadingPitchRange(0, -1.0, boundingSphere.radius * 2.5)
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    async function calculateRoute(inputWaypoints, options = {}) {
        if (!state.viewer) {
            throw new Error('RoutePlanner has no viewer set');
        }

        const config = { ...DEFAULTS, ...options };
        if (!Array.isArray(inputWaypoints) || inputWaypoints.length < 2) {
            throw new Error('Need at least 2 waypoints to calculate a route');
        }

        const normalized = normalizeWaypoints(inputWaypoints, config.defaultAltitudeM);
        const plannedAltitude = Number.isFinite(config.plannedAltitude)
            ? config.plannedAltitude
            : normalized.reduce((sum, wp) => sum + wp.alt, 0) / normalized.length;

        await loadOsmBuildings(config);
        await focusCameraOnRoute(normalized);

        const serverResult = await requestServerRoute(normalized, config);
        const plannedWaypoints = (serverResult.waypoints || []).map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: wp.altitude_m,
            phase: wp.phase
        }));
        const hydratedWaypoints = await applyTerrainToServerWaypoints(plannedWaypoints);
        const hazards = Array.isArray(serverResult.hazards) ? serverResult.hazards : [];
        const maxObstacleHeight = hazards.reduce((max, hazard) => {
            const height = Number.isFinite(hazard.height_m) ? hazard.height_m : 0;
            return Math.max(max, height);
        }, 0);
        const stats = serverResult.stats || {};
        const suggestedAltitude = Number.isFinite(stats.max_altitude)
            ? stats.max_altitude
            : plannedAltitude;
        const maxAgl = Number.isFinite(stats.max_agl) ? stats.max_agl : null;
        const samplePoints = Number.isFinite(serverResult.sample_points)
            ? serverResult.sample_points
            : (serverResult.nodes_visited || hydratedWaypoints.length);

        return {
            waypoints: hydratedWaypoints.length ? hydratedWaypoints : normalized,
            originalWaypoints: normalized,
            samplePoints,
            plannedAltitude,
            analysis: {
                points: [],
                maxObstacleHeight,
                maxBuildingHeight: maxObstacleHeight,
                hazards
            },
            validation: {
                isValid: true,
                violations: [],
                suggestedAltitude,
                suggestedAGL: maxAgl,
                maxObstacleHeight,
                maxBuildingHeight: maxObstacleHeight,
                faaCompliant: maxAgl !== null ? maxAgl <= config.FAA_MAX_ALTITUDE_AGL_M : true,
                summary: `Server route plan (${serverResult.optimized_points || plannedWaypoints.length} points)`
            },
            optimized: true,
            optimization: {
                nodesVisited: serverResult.nodes_visited || 0,
                stats: serverResult.stats || null
            },
            timestamp: new Date().toISOString()
        };
    }

    async function init(viewer, options = {}) {
        state.viewer = viewer;
        const {
            osmTileset,
            loadBuildings = true,
            ...configOverrides
        } = options || {};
        if (osmTileset) {
            state.osmTileset = osmTileset;
        }
        const config = { ...DEFAULTS, ...configOverrides };
        if (loadBuildings === false) {
            return { viewer };
        }
        if (!state.osmTileset) {
            await loadOsmBuildings(config);
        }
        return { viewer };
    }

    root.RoutePlanner = {
        init,
        calculateRoute,
        computeRouteDistance
    };
})(typeof window !== 'undefined' ? window : this);
