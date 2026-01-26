/**
 * Flight Planner - Route Calculator & FAA Validator
 * 
 * Standalone "Pilot's Tablet" application for pre-flight planning.
 * Calculates 3D routes using OSM Buildings and validates FAA Part 107 compliance.
 * 
 * Architecture: Mission Control Pattern
 * - This app is WRITE-ONLY (submits flight plans)
 * - flight-spotlight is READ-ONLY (visualizes flights)
 * - atc-server is the central orchestrator
 * 
 * @module planner
 */

(function (root) {
    'use strict';

    // ============================================================================
    // Configuration
    // ============================================================================

    const CONFIG = Object.assign({
        // Cesium Assets
        OSM_BUILDINGS_ASSET_ID: 96188,

        // FAA Part 107 Regulations
        FAA_MAX_ALTITUDE_AGL_M: 121, // ~400 feet Above Ground Level

        // Safety Parameters
        DEFAULT_SAFETY_BUFFER_M: 20,
        DEFAULT_SAMPLE_SPACING_M: 5,   // Sample every 5m (balance between accuracy and performance)

        // Fan Search Lateral Offsets
        DEFAULT_LANE_SPACING_M: 15,
        DEFAULT_LANE_RADIUS_M: 90,
        MAX_LANE_RADIUS_M: 240,
        LANE_EXPANSION_STEP_M: 60,

        TILESET_LOAD_TIMEOUT_MS: 15000,
        CAMERA_HEIGHT_ABOVE_TERRAIN: 600,
        CORRIDOR_SAMPLE_RADIUS_M: 10,  // Sample radius for corridor (slightly > display radius of 8m)
        CORRIDOR_SAMPLE_SPACING_M: 3,  // Dense sampling for corridor check

        // ATC Server Endpoint
        ATC_SERVER_URL: '',
        // Reserve an operational intent (slot), then confirm from Mission Control.
        SUBMIT_FLIGHT_ENDPOINT: '/v1/operational_intents/reserve',
        DRONE_SPEED_MPS: 15
    }, root.__ROUTE_PLANNER_CONFIG__ || safeParentValue('__ROUTE_PLANNER_CONFIG__') || {});

    const ATC_BASE_FALLBACK = '/api/atc';

    function safeParentUser() {
        try {
            if (root.parent && root.parent !== root) {
                return root.parent.APP_USER || null;
            }
        } catch (error) {
            return null;
        }
        return null;
    }

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

    function resolveAtcBase() {
        const candidates = [
            root.__ATC_API_BASE__,
            safeParentValue('__ATC_API_BASE__'),
            CONFIG.ATC_SERVER_URL
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }
        return ATC_BASE_FALLBACK;
    }

    function resolveComplianceClearance() {
        const complianceLimits = root.__ATC_COMPLIANCE_LIMITS__
            || safeParentValue('__ATC_COMPLIANCE_LIMITS__')
            || {};
        const clearance = Number.isFinite(complianceLimits.defaultClearanceM)
            ? complianceLimits.defaultClearanceM
            : CONFIG.DEFAULT_SAFETY_BUFFER_M;
        return clearance;
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

    function resolveOwnerId() {
        const user = root.APP_USER || safeParentUser();
        if (!user || user.role === 'authority') return null;
        return user.id || null;
    }

    async function listDrones() {
        const base = resolveAtcBase();
        const params = new URLSearchParams();
        const ownerId = resolveOwnerId();
        if (ownerId) params.set('owner_id', ownerId);
        const url = joinUrl(base, `/v1/drones${params.toString() ? `?${params.toString()}` : ''}`);
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error(`Drone list failed: ${response.status}`);
        }
        return response.json();
    }

    async function listGeofences() {
        const base = resolveAtcBase();
        const url = joinUrl(base, '/v1/geofences');
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error(`Geofence list failed: ${response.status}`);
        }
        return response.json();
    }

    async function checkGeofenceRoute(waypoints) {
        const base = resolveAtcBase();
        const url = joinUrl(base, '/v1/geofences/check-route');
        const payload = {
            waypoints: (waypoints || []).map((wp) => ({
                lat: wp.lat,
                lon: wp.lon,
                altitude_m: wp.alt
            }))
        };
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Geofence route check failed: ${response.status}`);
        }
        return response.json();
    }

    async function evaluateCompliance(waypoints) {
        const base = resolveAtcBase();
        const url = joinUrl(base, '/v1/compliance/evaluate');
        const cruiseSpeed = CONFIG.DRONE_SPEED_MPS;
        const defaultClearance = resolveComplianceClearance();
        const routeWaypoints = (waypoints || []).map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: Number.isFinite(wp.alt) ? wp.alt : 0
        }));
        const waypointsWithTime = calculateTimeOffsets(routeWaypoints, cruiseSpeed);
        const battery = estimateBatteryMetrics(waypointsWithTime);
        const metadata = {
            drone_speed_mps: cruiseSpeed,
            battery_capacity_min: battery.capacityMin,
            battery_reserve_min: battery.reserveMin,
            clearance_m: defaultClearance,
            operation_type: 1
        };

        const payload = {
            waypoints: routeWaypoints.map((wp) => ({
                lat: wp.lat,
                lon: wp.lon,
                altitude_m: wp.alt
            })),
            metadata
        };
        if (selectedDroneId) {
            payload.drone_id = selectedDroneId;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `Compliance check failed: ${response.status}`);
        }
        return response.json();
    }

    function setSelectedDroneId(droneId) {
        selectedDroneId = droneId || null;
    }

    function getSelectedDroneId() {
        return selectedDroneId;
    }

    // ============================================================================
    // State
    // ============================================================================

    let viewer = null;
    let osmTileset = null;
    let osmTilesetPromise = null;
    let waypoints = [];          // Array of {lat, lon, alt} objects
    let waypointEntities = [];   // Cesium entities for visualization
    let routeEntity = null;      // Polyline showing the route
    let safetyVolumeEntity = null; // 3D tube showing safety corridor
    let selectedDroneId = null;
    let geofenceEntities = new Map(); // geofence_id -> [entities]

    // ============================================================================
    // Initialization
    // ============================================================================

    /**
     * Initialize the Cesium viewer with terrain and OSM Buildings
     * @param {string} containerId - DOM element ID for the viewer
     * @param {string} ionToken - Cesium Ion access token
     * @returns {Promise<Cesium.Viewer>}
     */
	    async function initViewer(containerId, ionToken) {
	        Cesium.Ion.defaultAccessToken = ionToken;

	        console.log('[Planner] Initializing Cesium viewer...');

	        viewer = new Cesium.Viewer(containerId, {
            terrainProvider: await Cesium.createWorldTerrainAsync(),
            animation: false,
            timeline: false,
            baseLayerPicker: false,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,
            selectionIndicator: true,
            navigationHelpButton: false,
            infoBox: true,
            fullscreenButton: false
	        });

	        viewer.scene.globe.depthTestAgainstTerrain = true;

	        if (root.ATCCameraControls && typeof root.ATCCameraControls.attach === 'function') {
	            root.ATCCameraControls.attach(viewer);
	        }

	        // Load OSM Buildings
	        console.log('[Planner] Loading OSM Buildings tileset...');
	        osmTileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.OSM_BUILDINGS_ASSET_ID);
	        viewer.scene.primitives.add(osmTileset);
	        await osmTileset.readyPromise;
	        console.log('[Planner] OSM Buildings loaded');

        if (root.RoutePlanner && typeof root.RoutePlanner.init === 'function') {
            await root.RoutePlanner.init(viewer, {
                loadBuildings: false,
                osmTileset: osmTileset
            });
        }

        // Set up click handler for waypoint placement
        setupClickHandler();

        return viewer;
    }

    /**
     * Set up map click handler for adding waypoints
     */
    function setupClickHandler() {
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

        handler.setInputAction(async function (click) {
            // Get position from click
            const ray = viewer.camera.getPickRay(click.position);
            const position = viewer.scene.globe.pick(ray, viewer.scene);

            if (position) {
                const cartographic = Cesium.Cartographic.fromCartesian(position);
                const lat = Cesium.Math.toDegrees(cartographic.latitude);
                const lon = Cesium.Math.toDegrees(cartographic.longitude);
                const terrainHeight = cartographic.height || 0;

                // Default flight altitude: 50m above terrain
                const defaultAltitude = terrainHeight + 50;

                addWaypoint(lat, lon, defaultAltitude);
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    // ============================================================================
    // Waypoint Management
    // ============================================================================

    /**
     * Add a waypoint to the route
     * @param {number} lat - Latitude
     * @param {number} lon - Longitude
     * @param {number} alt - Altitude in meters (above ellipsoid)
     */
    /**
     * Get waypoint label that matches the sidebar UI:
     * - Index 1: "A (Start)"
     * - Intermediate: "1", "2", "3"... (numbered stops)
     * - Last: "B" (destination)
     */
    function getWaypointLabel(index, totalWaypoints) {
        if (index === 1) {
            return 'A (Start)';
        } else if (index === totalWaypoints) {
            return 'B';
        } else {
            // Intermediate stops are numbered starting from 1
            return String(index - 1);
        }
    }

    function addWaypoint(lat, lon, alt) {
        const waypointIndex = waypoints.length + 1;

        waypoints.push({ lat, lon, alt, index: waypointIndex });

        // Generate label that matches sidebar: A (Start), 1, 2, ... B
        const labelText = getWaypointLabel(waypointIndex, waypointIndex);

        // Determine marker color: green for start, cyan for others
        const isStart = waypointIndex === 1;

        // Add visual marker
        const entity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
            point: {
                pixelSize: 14,
                color: isStart ? Cesium.Color.LIME : Cesium.Color.CYAN,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2
            },
            label: {
                text: labelText,
                font: '14px Inter, sans-serif',
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString('#0f172a').withAlpha(0.8),
                backgroundPadding: new Cesium.Cartesian2(6, 4),
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -20)
            }
        });

        waypointEntities.push(entity);

        // Update ALL waypoint labels to reflect the new total count
        // (previous "B" should become a number, new waypoint becomes "B")
        updateWaypointLabels();

        // Update route visualization
        updateRouteVisualization();

        // Notify UI
        if (root.onWaypointAdded) {
            root.onWaypointAdded(waypoints);
        }

        console.log(`[Planner] Waypoint ${waypointIndex} added: (${lat.toFixed(5)}, ${lon.toFixed(5)}) at ${alt.toFixed(1)}m`);
    }

    /**
     * Update all waypoint labels to match the sidebar pattern:
     * A (Start), 1, 2, 3..., B
     * This is called after adding/removing waypoints.
     */
    function updateWaypointLabels() {
        const total = waypointEntities.length;
        waypointEntities.forEach((entity, idx) => {
            const labelText = getWaypointLabel(idx + 1, total);
            if (entity.label) {
                entity.label.text = labelText;
            }
        });
    }

    /**
     * Add a waypoint by coordinates (auto-samples terrain if altitude omitted).
     */
    async function addWaypointByCoords(lat, lon, altitude = null) {
        if (!viewer) {
            throw new Error('Planner not initialized');
        }

        let resolvedAlt = Number.isFinite(altitude) ? altitude : null;
        if (resolvedAlt === null) {
            try {
                const terrainHeight = await getTerrainHeight(lat, lon);
                resolvedAlt = terrainHeight + 50;
            } catch (error) {
                console.warn('[Planner] Terrain sample failed, using default altitude:', error);
                resolvedAlt = 50;
            }
        }

        addWaypoint(lat, lon, resolvedAlt);
        return { lat, lon, alt: resolvedAlt };
    }

    async function getTerrainHeight(lat, lon) {
        if (!viewer) {
            return 0;
        }
        const carto = Cesium.Cartographic.fromDegrees(lon, lat);
        try {
            const sampled = await Cesium.sampleTerrainMostDetailed(
                viewer.terrainProvider,
                [carto]
            );
            const height = sampled && sampled[0] ? sampled[0].height : null;
            if (Number.isFinite(height)) {
                return height;
            }
        } catch (error) {
            console.warn('[Planner] Terrain sample failed:', error);
        }
        const fallback = viewer.scene.globe.getHeight(carto);
        return Number.isFinite(fallback) ? fallback : 0;
    }

    /**
     * Clear all waypoints and reset the route
     */
    function clearWaypoints() {
        waypoints = [];

        waypointEntities.forEach(e => viewer.entities.remove(e));
        waypointEntities = [];

        if (routeEntity) {
            viewer.entities.remove(routeEntity);
            routeEntity = null;
        }

        if (safetyVolumeEntity) {
            viewer.entities.remove(safetyVolumeEntity);
            safetyVolumeEntity = null;
        }

        if (root.onWaypointsCleared) {
            root.onWaypointsCleared();
        }

        console.log('[Planner] All waypoints cleared');
    }

    /**
     * Update the route polyline visualization
     */
    function updateRouteVisualization() {
        if (routeEntity) {
            viewer.entities.remove(routeEntity);
        }

        if (waypoints.length < 2) return;

        const positions = waypoints.map(wp =>
            Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt)
        );

        routeEntity = viewer.entities.add({
            polyline: {
                positions: positions,
                width: 4,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.YELLOW,
                    dashLength: 16
                }),
                clampToGround: false
            }
        });
    }

    // ============================================================================
    // Geofence Visualization
    // ============================================================================

    function normalizeGeofenceType(type) {
        return (type || '').toString().toLowerCase();
    }

    function getGeofenceStyle(type) {
        switch (normalizeGeofenceType(type)) {
            case 'no_fly_zone':
                return { fill: '#ef4444', outline: '#ef4444', alpha: 0.25 };
            case 'restricted_area':
                return { fill: '#f59e0b', outline: '#f59e0b', alpha: 0.2 };
            case 'temporary_restriction':
                return { fill: '#f97316', outline: '#f97316', alpha: 0.2 };
            case 'advisory':
                return { fill: '#38bdf8', outline: '#38bdf8', alpha: 0.15 };
            default:
                return { fill: '#94a3b8', outline: '#94a3b8', alpha: 0.12 };
        }
    }

    function clearGeofenceEntities() {
        geofenceEntities.forEach((entities) => {
            entities.forEach((entity) => viewer.entities.remove(entity));
        });
        geofenceEntities.clear();
    }

    function computeGeofenceCentroid(polygon) {
        if (!Array.isArray(polygon) || polygon.length === 0) return null;
        let points = polygon;
        if (polygon.length > 1) {
            const first = polygon[0];
            const last = polygon[polygon.length - 1];
            if (first[0] === last[0] && first[1] === last[1]) {
                points = polygon.slice(0, -1);
            }
        }
        if (points.length === 0) return null;
        const sum = points.reduce((acc, point) => {
            acc.lat += point[0];
            acc.lon += point[1];
            return acc;
        }, { lat: 0, lon: 0 });
        return {
            lat: sum.lat / points.length,
            lon: sum.lon / points.length
        };
    }

    function renderGeofences(geofences) {
        if (!viewer) return;
        clearGeofenceEntities();

        (geofences || [])
            .filter((geofence) => geofence && geofence.active)
            .forEach((geofence) => {
                const polygon = geofence.polygon || [];
                if (polygon.length < 3) return;

                const lower = Number.isFinite(geofence.lower_altitude_m)
                    ? geofence.lower_altitude_m
                    : 0;
                const upper = Number.isFinite(geofence.upper_altitude_m)
                    ? geofence.upper_altitude_m
                    : lower;
                const height = Math.min(lower, upper);
                const extrudedHeight = Math.max(lower, upper);
                const style = getGeofenceStyle(geofence.geofence_type);

                const positions = polygon.map(([lat, lon]) =>
                    Cesium.Cartesian3.fromDegrees(lon, lat, height)
                );

                const polygonEntity = viewer.entities.add({
                    polygon: {
                        hierarchy: new Cesium.PolygonHierarchy(positions),
                        height: height,
                        extrudedHeight: extrudedHeight,
                        material: Cesium.Color.fromCssColorString(style.fill).withAlpha(style.alpha),
                        outline: true,
                        outlineColor: Cesium.Color.fromCssColorString(style.outline),
                        outlineWidth: 2
                    }
                });

                const entities = [polygonEntity];
                const centroid = computeGeofenceCentroid(polygon);
                if (centroid) {
                    const labelEntity = viewer.entities.add({
                        position: Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, extrudedHeight + 5),
                        label: {
                            text: geofence.name || 'Geofence',
                            font: '13px Inter, sans-serif',
                            fillColor: Cesium.Color.fromCssColorString(style.outline),
                            outlineColor: Cesium.Color.fromCssColorString('#0f172a'),
                            outlineWidth: 3,
                            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                            pixelOffset: new Cesium.Cartesian2(0, -6)
                        }
                    });
                    entities.push(labelEntity);
                }

                geofenceEntities.set(geofence.id || `${Math.random()}`, entities);
            });
    }

    async function refreshGeofences() {
        const geofences = await listGeofences();
        renderGeofences(geofences);
        return geofences;
    }

    // ============================================================================
    // Calculate Full Route (with Auto-Resolution)
    // ============================================================================

    /**
     * Calculate a complete flight route using the server planner.
     * @returns {Promise<Object>} Full route analysis response
     */
    async function calculateRoute() {
        if (waypoints.length < 2) {
            throw new Error('Need at least 2 waypoints to calculate a route');
        }

        const plannedAltitude = waypoints.reduce((sum, wp) => sum + wp.alt, 0) / waypoints.length;
        let geofences = [];
        try {
            geofences = await refreshGeofences();
        } catch (error) {
            console.warn('[Planner] Failed to refresh geofences for routing:', error);
            geofences = [];
        }

        // Route planning is now server-only - RoutePlanner must be available
        if (!root.RoutePlanner || typeof root.RoutePlanner.calculateRoute !== 'function') {
            throw new Error('Route planning service not available. RoutePlanner module is required.');
        }

        console.log('[Planner] ========================================');
        console.log('[Planner] CALCULATING ROUTE (Server-side)');
        console.log('[Planner] ========================================');

        const result = await root.RoutePlanner.calculateRoute(waypoints, {
            plannedAltitude,
            defaultAltitudeM: plannedAltitude,
            geofences,
            OSM_BUILDINGS_ASSET_ID: CONFIG.OSM_BUILDINGS_ASSET_ID,
            FAA_MAX_ALTITUDE_AGL_M: CONFIG.FAA_MAX_ALTITUDE_AGL_M,
            DEFAULT_SAFETY_BUFFER_M: CONFIG.DEFAULT_SAFETY_BUFFER_M,
            DEFAULT_SAMPLE_SPACING_M: CONFIG.DEFAULT_SAMPLE_SPACING_M,
            DEFAULT_LANE_RADIUS_M: CONFIG.DEFAULT_LANE_RADIUS_M
        });

        if (Array.isArray(result?.waypoints) && result.waypoints.length) {
            await updateOptimizedRouteVisualization(result.waypoints);
        }

        if (root.onRouteCalculated) {
            root.onRouteCalculated(result);
        }

        return result;
    }

    /**
     * Compute circle shape for polylineVolume (safety corridor cross-section)
     * @param {number} radius - Circle radius in meters
     * @returns {Array} Array of Cartesian2 points forming a circle
     */
    function computeCircle(radius) {
        const positions = [];
        const numPoints = 36; // 10 degrees per point
        for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * 2 * Math.PI;
            positions.push(new Cesium.Cartesian2(
                radius * Math.cos(angle),
                radius * Math.sin(angle)
            ));
        }
        return positions;
    }

    /**
     * Update route visualization with optimized terrain-following path
     * Shows green "climb over" line AND cyan safety corridor tunnel
     */
    async function updateOptimizedRouteVisualization(optimizedWaypoints) {
        // Remove existing entities
        if (routeEntity) {
            viewer.entities.remove(routeEntity);
        }
        if (safetyVolumeEntity) {
            viewer.entities.remove(safetyVolumeEntity);
        }

        if (optimizedWaypoints.length < 2) return;

        const firstWp = optimizedWaypoints[0];
        const lastWp = optimizedWaypoints[optimizedWaypoints.length - 1];

        // Get terrain heights - sample if not available
        let takeoffGround = firstWp.terrainHeight;
        let landingGround = lastWp.terrainHeight;

        // Sample terrain if terrainHeight not set
        if (takeoffGround === undefined || takeoffGround === null) {
            try {
                const cartos = [Cesium.Cartographic.fromDegrees(firstWp.lon, firstWp.lat)];
                const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos);
                takeoffGround = sampled[0].height || 0;
            } catch (e) {
                takeoffGround = 0;
            }
        }
        if (landingGround === undefined || landingGround === null) {
            try {
                const cartos = [Cesium.Cartographic.fromDegrees(lastWp.lon, lastWp.lat)];
                const sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos);
                landingGround = sampled[0].height || 0;
            } catch (e) {
                landingGround = 0;
            }
        }

        console.log(`[Planner] Visualization: takeoff=${takeoffGround.toFixed(1)}m, cruise=${firstWp.alt.toFixed(1)}m, land=${landingGround.toFixed(1)}m`);

        const fullFlightPath = [];

        // Takeoff point (ground level at start)
        fullFlightPath.push(Cesium.Cartesian3.fromDegrees(firstWp.lon, firstWp.lat, takeoffGround));

        // All cruise waypoints
        optimizedWaypoints.forEach(wp => {
            fullFlightPath.push(Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt));
        });

        // Landing point (ground level at end)
        fullFlightPath.push(Cesium.Cartesian3.fromDegrees(lastWp.lon, lastWp.lat, landingGround));

        // Green glow polyline for full flight path (takeoff -> cruise -> landing)
        routeEntity = viewer.entities.add({
            polyline: {
                positions: fullFlightPath,
                width: 6,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.3,
                    color: Cesium.Color.LIME
                }),
                clampToGround: false
            }
        });

        // 3D Safety Corridor - only around cruise portion (not takeoff/landing)
        const cruisePositions = optimizedWaypoints.map(wp =>
            Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt)
        );

        const CORRIDOR_DISPLAY_RADIUS = 8;
        safetyVolumeEntity = viewer.entities.add({
            polylineVolume: {
                positions: cruisePositions,
                shape: computeCircle(CORRIDOR_DISPLAY_RADIUS),
                cornerType: Cesium.CornerType.ROUNDED,
                material: Cesium.Color.CYAN.withAlpha(0.15),
                outline: true,
                outlineColor: Cesium.Color.CYAN.withAlpha(0.4),
                outlineWidth: 1
            }
        });

        console.log('[Planner] Route visualization: takeoff -> cruise -> landing');
        console.log('[Planner] Optimized waypoints:');
        console.table(optimizedWaypoints.map((wp, i) => ({
            '#': i,
            'Lat': wp.lat?.toFixed(5),
            'Lon': wp.lon?.toFixed(5),
            'Alt': wp.alt?.toFixed(1),
            'Ground': wp.terrainHeight?.toFixed(1) || 'N/A'
        })));
    }

    // ============================================================================
    // Distance & Time Calculation Helpers
    // ============================================================================

    /**
     * Calculate the 3D distance between two waypoints (meters)
     * @param {Object} wp1 - First waypoint {lat, lon, alt}
     * @param {Object} wp2 - Second waypoint {lat, lon, alt}
     * @returns {number} Distance in meters
     */
    function calculateDistance(wp1, wp2) {
        const startCarto = Cesium.Cartographic.fromDegrees(wp1.lon, wp1.lat, wp1.alt);
        const endCarto = Cesium.Cartographic.fromDegrees(wp2.lon, wp2.lat, wp2.alt);

        // Surface distance using geodesic
        const geodesic = new Cesium.EllipsoidGeodesic(startCarto, endCarto);
        const surfaceDistance = geodesic.surfaceDistance;

        // Add vertical component for 3D distance
        const verticalDelta = Math.abs(wp2.alt - wp1.alt);
        const distance3D = Math.sqrt(surfaceDistance * surfaceDistance + verticalDelta * verticalDelta);

        return distance3D;
    }

    /**
     * Calculate cumulative time offsets for waypoints at given speed
     * @param {Array} waypoints - Array of {lat, lon, alt}
     * @param {number} speedMps - Drone speed in meters per second
     * @returns {Array} Waypoints with time_offset added
     */
    function calculateTimeOffsets(waypoints, speedMps) {
        if (waypoints.length === 0) return [];

        const result = [];
        let cumulativeTime = 0;

        for (let i = 0; i < waypoints.length; i++) {
            const wp = waypoints[i];

            if (i > 0) {
                const distance = calculateDistance(waypoints[i - 1], wp);
                const segmentTime = distance / speedMps;
                cumulativeTime += segmentTime;
            }

            result.push({
                lat: wp.lat,
                lon: wp.lon,
                alt: wp.alt,
                time_offset: Math.round(cumulativeTime * 100) / 100 // Round to 2 decimals
            });
        }

        return result;
    }

    function estimateBatteryMetrics(waypointsWithTime) {
        const totalFlightTime = waypointsWithTime.length > 0
            ? waypointsWithTime[waypointsWithTime.length - 1].time_offset
            : 0;
        const estimatedMinutes = totalFlightTime > 0 ? totalFlightTime / 60 : 0;
        const reserveMin = Math.max(5, Math.ceil(estimatedMinutes * 0.2));
        const capacityMin = Math.ceil(estimatedMinutes + reserveMin + 2);

        return {
            totalFlightTime,
            estimatedMinutes,
            reserveMin,
            capacityMin
        };
    }

    /**
     * Generate a crypto-random UUID
     * @returns {string} UUID v4 format
     */
    function generateFlightId() {
        // Use crypto API if available, fallback to random
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback UUID v4 generation
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // ============================================================================
    // 4D Trajectory Densification
    // ============================================================================

    /**
     * Densify waypoints by interpolating every 1 meter for high-fidelity trajectory
     * @param {Array} waypoints - Sparse waypoints array
     * @param {number} speedMps - Drone speed in meters per second (default: 15)
     * @returns {Array} Dense trajectory with { lat, lon, alt, time_offset }
     */
    function densifyRoute(waypoints, speedMps = 15) {
        if (!waypoints || waypoints.length < 2) return [];

        const trajectory = [];
        let cumulativeTime = 0;

        // Add first waypoint
        trajectory.push({
            lat: waypoints[0].lat,
            lon: waypoints[0].lon,
            alt: waypoints[0].alt,
            time_offset: 0
        });

        for (let i = 0; i < waypoints.length - 1; i++) {
            const start = waypoints[i];
            const end = waypoints[i + 1];

            // Calculate segment distance
            const distance = calculateDistance(start, end);
            const numSteps = Math.ceil(distance / 1.0); // 1m spacing

            if (numSteps === 0) continue;

            const timePerStep = 1.0 / speedMps; // Time to travel 1m

            // Interpolate points along segment
            for (let j = 1; j <= numSteps; j++) {
                const t = j / numSteps;

                // Linear interpolation
                const lat = start.lat + t * (end.lat - start.lat);
                const lon = start.lon + t * (end.lon - start.lon);
                const alt = start.alt + t * (end.alt - start.alt);

                cumulativeTime += timePerStep;

                trajectory.push({
                    lat: parseFloat(lat.toFixed(7)),
                    lon: parseFloat(lon.toFixed(7)),
                    alt: parseFloat(alt.toFixed(2)),
                    time_offset: parseFloat(cumulativeTime.toFixed(2))
                });
            }
        }

        console.log(`[Planner] Densified trajectory: ${waypoints.length} waypoints -> ${trajectory.length} points`);
        return trajectory;
    }

    // ============================================================================
    // Submit to ATC Server
    // ============================================================================

    /**
     * Submit the flight plan to ATC Server
     * @param {Object} routeData - Route calculation result
     * @returns {Promise<Object>} Submission result
     */
    async function submitToATC(routeData) {
        const complianceOk = routeData?.complianceCheck?.ok;
        if (complianceOk !== true) {
            throw new Error('Compliance check incomplete or failed');
        }

        console.log('[Planner] ========================================');
        console.log('[Planner] SUBMITTING FLIGHT PLAN TO ATC SERVER');
        console.log('[Planner] ========================================');

        // Configuration
        const droneSpeed = CONFIG.DRONE_SPEED_MPS;

        // Generate or reuse a unique flight ID (allows external pre-declaration)
        const requestedFlightId = routeData && (routeData.flightId || routeData.flight_id);
        const flightId = requestedFlightId || generateFlightId();
        if (routeData && !routeData.flightId) {
            routeData.flightId = flightId;
        }

        // Calculate time offsets for each waypoint
        const waypointsWithTime = calculateTimeOffsets(routeData.waypoints, droneSpeed);

        const batteryMetrics = estimateBatteryMetrics(waypointsWithTime);
        const totalFlightTime = batteryMetrics.totalFlightTime;

        // Calculate total distance
        let totalDistance = 0;
        for (let i = 1; i < routeData.waypoints.length; i++) {
            totalDistance += calculateDistance(routeData.waypoints[i - 1], routeData.waypoints[i]);
        }

        // Generate high-fidelity 4D trajectory (1m spacing for conflict detection)
        const trajectoryLog = densifyRoute(routeData.waypoints, droneSpeed);
        const reserveMin = batteryMetrics.reserveMin;
        const capacityMin = batteryMetrics.capacityMin;
        const clearanceM = resolveComplianceClearance();

        const effectiveDroneId = selectedDroneId
            || routeData?.droneId
            || routeData?.drone_id
            || (`PLANNER-${flightId}`);

        // FlightPlanRequest payload for /v1/operational_intents/reserve
        const payload = {
            drone_id: effectiveDroneId,
            waypoints: waypointsWithTime.map((wp) => ({
                lat: wp.lat,
                lon: wp.lon,
                altitude_m: wp.alt,
                speed_mps: droneSpeed
            })),
            trajectory_log: trajectoryLog.map((pt) => ({
                lat: pt.lat,
                lon: pt.lon,
                altitude_m: pt.alt,
                time_offset_s: pt.time_offset
            })),
            metadata: {
                drone_speed_mps: droneSpeed,
                total_distance_m: Math.round(totalDistance),
                total_flight_time_s: Math.round(totalFlightTime),
                trajectory_points: trajectoryLog.length,
                planned_altitude_m: routeData.plannedAltitude,
                max_obstacle_height_m: routeData.analysis.maxObstacleHeight,
                faa_compliant: complianceOk,
                submitted_at: new Date().toISOString(),
                operation_type: 1,
                battery_capacity_min: capacityMin,
                battery_reserve_min: reserveMin,
                clearance_m: clearanceM,
                compliance_override_enabled: false
            },
            departure_time: routeData?.departure_time
                || routeData?.start_datetime
                || routeData?.missionStart
                || undefined
        };

        const blenderDeclarationId = routeData && (routeData.blenderDeclarationId || routeData.blender_declaration_id);
        if (blenderDeclarationId) {
            payload.metadata.blender_declaration_id = blenderDeclarationId;
        }

        try {
            const ownerId = resolveOwnerId();
            if (ownerId && (payload.owner_id === undefined || payload.owner_id === null)) {
                payload.owner_id = ownerId;
            }
            const submitUrl = joinUrl(resolveAtcBase(), CONFIG.SUBMIT_FLIGHT_ENDPOINT);
            const response = await fetch(submitUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'same-origin',
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const text = await response.text();
                let parsed = null;
                try {
                    parsed = text ? JSON.parse(text) : null;
                } catch (error) {
                    parsed = null;
                }
                const detail = parsed?.message || parsed?.error || text || response.statusText;
                throw new Error(`ATC Server returned ${response.status}: ${detail}`);
            }

            let result = {};
            try {
                result = await response.json();
            } catch (error) {
                result = {};
            }
            console.log('[Planner] Flight plan submitted successfully:', result);

            const responsePayload = {
                ...result,
                payload: payload
            };
            if (root.onFlightSubmitted) {
                root.onFlightSubmitted(responsePayload);
            }

            return responsePayload;

        } catch (error) {
            console.error('[Planner] Failed to submit flight plan:', error);
            throw error;
        }
    }

    // ============================================================================
    // Utilities
    // ============================================================================

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Fly camera to a location
     */
    function flyTo(lat, lon, altitude = 1000) {
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, altitude),
            orientation: {
                heading: 0,
                pitch: Cesium.Math.toRadians(-45),
                roll: 0
            },
            duration: 1.5
        });
    }

    // ============================================================================
    // Public API
    // ============================================================================

    root.FlightPlanner = {
        // Initialization
        initViewer,

        // Waypoint Management
        addWaypoint,
        addWaypointByCoords,
        clearWaypoints,
        getWaypoints: () => [...waypoints],

        // Route Calculation
        calculateRoute,

        // ATC Submission
        submitToATC,

        // Drone binding
        listDrones,
        setSelectedDroneId,
        getSelectedDroneId,

        // Geofences
        listGeofences,
        checkGeofenceRoute,
        refreshGeofences,
        renderGeofences,

        // Compliance
        evaluateCompliance,

        // Utilities
        flyTo,
        getViewer: () => viewer,

        // Configuration
        CONFIG
    };

})(typeof window !== 'undefined' ? window : this);
