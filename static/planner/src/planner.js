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

    const CONFIG = {
        // Cesium Assets
        OSM_BUILDINGS_ASSET_ID: 96188,

        // FAA Part 107 Regulations
        FAA_MAX_ALTITUDE_AGL_M: 121, // ~400 feet Above Ground Level

        // Safety Parameters
        DEFAULT_SAFETY_BUFFER_M: 20,
        DEFAULT_SAMPLE_SPACING_M: 1,   // Sample every 5m (balance between accuracy and performance)

        // Fan Search Lateral Offsets (13 lanes @ 15m spacing) - Dense for better obstacle coverage
        FAN_OFFSETS: [-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90],

        TILESET_LOAD_TIMEOUT_MS: 15000,
        CAMERA_HEIGHT_ABOVE_TERRAIN: 600,

        // ATC Server Endpoint
        ATC_SERVER_URL: '',
        SUBMIT_FLIGHT_ENDPOINT: '/v1/flights'
    };

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
            CONFIG.ATC_SERVER_URL,
            root.__ATC_API_BASE__,
            safeParentValue('__ATC_API_BASE__')
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }
        return ATC_BASE_FALLBACK;
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

        // Load OSM Buildings
        console.log('[Planner] Loading OSM Buildings tileset...');
        osmTileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.OSM_BUILDINGS_ASSET_ID);
        viewer.scene.primitives.add(osmTileset);
        await osmTileset.readyPromise;
        console.log('[Planner] OSM Buildings loaded');

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
    function addWaypoint(lat, lon, alt) {
        const waypointIndex = waypoints.length + 1;

        waypoints.push({ lat, lon, alt, index: waypointIndex });

        // Add visual marker
        const entity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
            point: {
                pixelSize: 14,
                color: waypointIndex === 1 ? Cesium.Color.LIME : Cesium.Color.CYAN,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2
            },
            label: {
                text: waypointIndex === 1 ? 'A (Start)' : `WP${waypointIndex}`,
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

        // Update route visualization
        updateRouteVisualization();

        // Notify UI
        if (root.onWaypointAdded) {
            root.onWaypointAdded(waypoints);
        }

        console.log(`[Planner] Waypoint ${waypointIndex} added: (${lat.toFixed(5)}, ${lon.toFixed(5)}) at ${alt.toFixed(1)}m`);
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
    // Height Sampling (Ported from safe-corridor.js)
    // ============================================================================

    /**
     * Get terrain height at a location
     */
    async function getTerrainHeight(lat, lon) {
        const positions = [Cesium.Cartographic.fromDegrees(lon, lat)];
        const results = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions);
        return results[0].height || 0;
    }

    /**
     * Generate a sampling grid along the route (5 lanes wide)
     * @param {Array} waypoints - User waypoints
     * @param {Number} spacingMeters - Spacing between steps
     * @returns {Object} Grid structure { lanes: [[{lat,lon,alt}, ...], ...], centerLine: [...] }
     */
    function generateGridSamples(waypoints, spacingMeters) {
        if (waypoints.length < 2) return null;

        const lanes = CONFIG.FAN_OFFSETS.map(() => []);
        const centerLine = [];
        const waypointIndices = [0]; // Track which grid steps are user waypoints (first is always 0)
        let totalSteps = 0;

        for (let i = 0; i < waypoints.length - 1; i++) {
            const start = waypoints[i];
            const end = waypoints[i + 1];

            const startCarto = Cesium.Cartographic.fromDegrees(start.lon, start.lat);
            const endCarto = Cesium.Cartographic.fromDegrees(end.lon, end.lat);
            const geodesic = new Cesium.EllipsoidGeodesic(startCarto, endCarto);
            const distance = geodesic.surfaceDistance;
            const heading = geodesic.startHeading;

            // Compute perpendicular heading for lateral offsets (Right +90 deg)
            const rightHeading = heading + (Math.PI / 2);

            // Interpolate points along the segment
            const numSteps = Math.ceil(distance / spacingMeters);

            // For each step along the segment
            for (let j = 0; j <= numSteps; j++) {
                // Skip the last point of segment if it's the start of next (except for very last leg)
                if (j === numSteps && i < waypoints.length - 2) continue;

                const fraction = j / numSteps;
                const centerPoint = geodesic.interpolateUsingSurfaceDistance(fraction * distance);
                const alt = start.alt + fraction * (end.alt - start.alt);

                // Convert center to Cartesian for offset calculation
                const centerCart = Cesium.Cartographic.toCartesian(centerPoint);

                // Store center point (matches original linear interpolation)
                centerLine.push({
                    lat: Cesium.Math.toDegrees(centerPoint.latitude),
                    lon: Cesium.Math.toDegrees(centerPoint.longitude),
                    alt: alt
                });

                // Generate lateral offset points for each lane
                CONFIG.FAN_OFFSETS.forEach((offset, laneIdx) => {
                    if (offset === 0) {
                        lanes[laneIdx].push({
                            lat: Cesium.Math.toDegrees(centerPoint.latitude),
                            lon: Cesium.Math.toDegrees(centerPoint.longitude),
                            alt: alt
                        });
                    } else {
                        // Robust method:
                        // 1. Get East-North-Up frame at center point
                        // 2. Rotate Heading to get Forward vector
                        // 3. Rotate +90 for Right vector
                        // 4. Position = Center + Right * offset

                        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(centerCart);
                        const matrix = Cesium.Matrix4.getMatrix3(transform, new Cesium.Matrix3());

                        // Heading vector in local ENU: [sin(heading), cos(heading), 0]
                        const enuRight = new Cesium.Cartesian3(
                            Math.sin(rightHeading),
                            Math.cos(rightHeading),
                            0
                        );

                        // Scale by offset
                        const offsetVec = Cesium.Cartesian3.multiplyByScalar(enuRight, offset, new Cesium.Cartesian3());

                        // Rotate to world coordinates
                        const worldOffset = Cesium.Matrix3.multiplyByVector(matrix, offsetVec, new Cesium.Cartesian3());
                        const finalPos = Cesium.Cartesian3.add(centerCart, worldOffset, new Cesium.Cartesian3());

                        const finalCarto = Cesium.Cartographic.fromCartesian(finalPos);

                        lanes[laneIdx].push({
                            lat: Cesium.Math.toDegrees(finalCarto.latitude),
                            lon: Cesium.Math.toDegrees(finalCarto.longitude),
                            alt: alt
                        });
                    }
                });
            }

            // Track where each user waypoint ends up in the grid
            totalSteps = centerLine.length;
            if (i < waypoints.length - 2) {
                waypointIndices.push(totalSteps - 1); // Last step of this segment = intermediate waypoint
            }
        }

        // Last waypoint is at the end
        waypointIndices.push(centerLine.length - 1);

        console.log(`[Planner] Grid created: ${centerLine.length} steps, Waypoint indices: ${waypointIndices.join(', ')}`);

        return { lanes, centerLine, waypointIndices };
    }

    /**
     * Sample building heights along a route using grid picking
     * @param {Array} routePoints - Array of {lat, lon} points
     * @returns {Promise<Object>} Height analysis results
     */
    /**
     * Sample building heights for the entire grid using batch request
     * Uses clampToHeightMostDetailed with explicit tileset reference
     * @param {Object} grid - Grid structure from generateGridSamples
     * @returns {Promise<Object>} Analyzed grid with obstacle heights
     */
    async function analyzeGrid(grid) {
        if (!grid) return null;

        console.log('[Planner] Batch sampling grid heights...');

        // Ensure OSM tileset is ready
        if (!osmTileset || !osmTileset.ready) {
            console.warn('[Planner] OSM Buildings tileset not ready, waiting...');
            await osmTileset.readyPromise;
        }
        console.log('[Planner] OSM Buildings tileset ready:', osmTileset.ready);

        // Force render and wait for tiles to load in view area
        viewer.scene.render();

        // Wait for tiles in the current view to load (important for height sampling)
        console.log('[Planner] Waiting for tiles to load in view area...');
        let tilesLoaded = false;
        let waitAttempts = 0;
        const maxWaitAttempts = 20; // 2 seconds max

        while (!tilesLoaded && waitAttempts < maxWaitAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            viewer.scene.render();
            tilesLoaded = osmTileset.tilesLoaded;
            waitAttempts++;
        }
        console.log(`[Planner] Tiles loaded: ${tilesLoaded} (waited ${waitAttempts * 100}ms)`);

        // Flatten all lane points into a single array for batch request
        const allPoints = [];
        const map = []; // To map back: map[i] = { laneIdx, pointIdx }

        grid.lanes.forEach((lane, laneIdx) => {
            lane.forEach((point, pointIdx) => {
                // Create Cartesian3 positions for clamping
                // Use a high altitude to ensure we clamp DOWN onto buildings
                const pos = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 1000);
                allPoints.push(pos);
                map.push({ laneIdx, pointIdx });
            });
        });

        console.log(`[Planner] Sending ${allPoints.length} height queries using clampToHeightMostDetailed...`);

        // Use clampToHeightMostDetailed to sample terrain AND 3D tiles
        // IMPORTANT: Second param is objectsToEXCLUDE - pass empty array to INCLUDE everything
        let clampedPositions;
        try {
            clampedPositions = await viewer.scene.clampToHeightMostDetailed(
                allPoints,
                [],  // Empty = exclude nothing = sample EVERYTHING including buildings
                1.0  // Width for sampling (1m precision for better building edge detection)
            );
        } catch (error) {
            console.error('[Planner] clampToHeightMostDetailed failed:', error);
            // Fallback: use terrain only - return positions at ground level
            clampedPositions = allPoints.map(pos => {
                if (!pos) return null;
                try {
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    return carto ? Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0) : null;
                } catch (e) {
                    return null;
                }
            });
        }

        // Also get terrain heights for AGL calculation
        console.log('[Planner] Sampling terrain base heights...');
        const terrainCartos = allPoints.map(pos => {
            if (!pos) return Cesium.Cartographic.fromDegrees(0, 0, 0);
            try {
                return Cesium.Cartographic.fromCartesian(pos);
            } catch (e) {
                return Cesium.Cartographic.fromDegrees(0, 0, 0);
            }
        }).filter(c => c !== null);

        let terrainHeights;
        try {
            terrainHeights = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, terrainCartos);
        } catch (error) {
            console.error('[Planner] Terrain sampling failed:', error);
            terrainHeights = terrainCartos; // Use unsample cartos as fallback
        }

        // Map results back to grid
        let maxObstacleHeight = -9999;
        let maxBuildingHeight = 0;
        let buildingsDetected = 0;

        clampedPositions.forEach((clampedPos, i) => {
            const { laneIdx, pointIdx } = map[i];
            const point = grid.lanes[laneIdx][pointIdx];
            const terrainCarto = terrainHeights[i];

            // SAFETY CHECK: Skip if clampedPos is undefined (can happen with Cesium API)
            if (!clampedPos) {
                console.warn(`[Planner] Undefined clampedPos at index ${i}, using terrain height`);
                point.obstacleHeight = terrainCarto ? terrainCarto.height : 0;
                point.terrainHeight = terrainCarto ? terrainCarto.height : 0;
                point.buildingHeight = 0;
                return;
            }

            // Get clamped height (building top or terrain)
            const clampedCarto = Cesium.Cartographic.fromCartesian(clampedPos);
            if (!clampedCarto) {
                console.warn(`[Planner] Failed to convert clampedPos at index ${i}`);
                point.obstacleHeight = terrainCarto ? terrainCarto.height : 0;
                point.terrainHeight = terrainCarto ? terrainCarto.height : 0;
                point.buildingHeight = 0;
                return;
            }

            const obstacleHeight = clampedCarto.height || 0;
            const terrainHeight = terrainCarto ? (terrainCarto.height || 0) : 0;

            point.obstacleHeight = obstacleHeight;
            point.terrainHeight = terrainHeight;

            // Calculate building height (AGL)
            point.buildingHeight = Math.max(0, obstacleHeight - terrainHeight);

            if (point.buildingHeight > 1) {
                buildingsDetected++;
            }

            maxObstacleHeight = Math.max(maxObstacleHeight, obstacleHeight);
            maxBuildingHeight = Math.max(maxBuildingHeight, point.buildingHeight);
        });

        console.log(`[Planner] Grid analysis complete.`);
        console.log(`[Planner]   Max obstacle altitude: ${maxObstacleHeight.toFixed(1)}m`);
        console.log(`[Planner]   Max building height (AGL): ${maxBuildingHeight.toFixed(1)}m`);
        console.log(`[Planner]   Buildings detected: ${buildingsDetected}/${allPoints.length} sample points`);

        return {
            grid,
            maxObstacleHeight,
            maxBuildingHeight
        };
    }

    // ============================================================================
    // FAA Validation (Ported from safe-corridor.js)
    // ============================================================================

    /**
     * Validate flight path against FAA Part 107 regulations
     * @param {Array} routeAnalysis - Results from analyzeRoute()
     * @param {number} plannedAltitude - Planned flight altitude
     * @returns {Object} Validation result
     */
    function validateFAA(routeAnalysis, plannedAltitude) {
        const violations = [];
        let isValid = true;

        for (const point of routeAnalysis.points) {
            const agl = plannedAltitude - point.terrainHeight;
            const clearance = plannedAltitude - point.obstacleHeight;

            // Check FAA 400ft limit
            if (agl > CONFIG.FAA_MAX_ALTITUDE_AGL_M) {
                violations.push({
                    type: 'FAA_ALTITUDE_EXCEEDED',
                    lat: point.lat,
                    lon: point.lon,
                    agl: agl,
                    limit: CONFIG.FAA_MAX_ALTITUDE_AGL_M,
                    message: `Altitude ${agl.toFixed(0)}m AGL exceeds FAA 400ft (${CONFIG.FAA_MAX_ALTITUDE_AGL_M}m) limit`
                });
                isValid = false;
            }

            // Check obstacle clearance
            if (clearance < CONFIG.DEFAULT_SAFETY_BUFFER_M) {
                violations.push({
                    type: 'INSUFFICIENT_CLEARANCE',
                    lat: point.lat,
                    lon: point.lon,
                    clearance: clearance,
                    required: CONFIG.DEFAULT_SAFETY_BUFFER_M,
                    message: `Only ${clearance.toFixed(0)}m clearance (need ${CONFIG.DEFAULT_SAFETY_BUFFER_M}m safety buffer)`
                });
                isValid = false;
            }
        }

        const suggestedAltitude = routeAnalysis.maxObstacleHeight + CONFIG.DEFAULT_SAFETY_BUFFER_M;
        const suggestedAGL = suggestedAltitude - Math.min(...routeAnalysis.points.map(p => p.terrainHeight));

        return {
            isValid,
            violations,
            suggestedAltitude,
            suggestedAGL,
            maxObstacleHeight: routeAnalysis.maxObstacleHeight,
            faaCompliant: suggestedAGL <= CONFIG.FAA_MAX_ALTITUDE_AGL_M,
            summary: isValid
                ? `APPROVED: Route is legal at ${plannedAltitude.toFixed(0)}m`
                : `DENIED: ${violations.length} violation(s) found`
        };
    }

    // ============================================================================
    // Calculate Full Route (with Auto-Resolution)
    // ============================================================================

    /**
     * Calculate and validate a complete flight route
     * If straight path is blocked, auto-optimizes using terrain following
     * @returns {Promise<Object>} Full route analysis with FAA validation
     */
    async function calculateRoute() {
        if (waypoints.length < 2) {
            throw new Error('Need at least 2 waypoints to calculate a route');
        }

        console.log('[Planner] ========================================');
        console.log('[Planner] CALCULATING ROUTE (Global A*)');
        console.log('[Planner] ========================================');

        // Step 0: Optimize View for Tile Loading
        // Fly to the route area to ensure 3D tiles are prioritized for loading
        console.log('[Planner] Focusing camera on route area...');
        const boundingSphere = Cesium.BoundingSphere.fromPoints(
            waypoints.map(wp => Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt))
        );

        // Use flyToBoundingSphere for smooth transition
        viewer.camera.flyToBoundingSphere(boundingSphere, {
            duration: 1.0,
            offset: new Cesium.HeadingPitchRange(0, -1.0, boundingSphere.radius * 2.5) // Top-down view
        });

        // Pause to allow Cesium to load tiles
        await new Promise(r => setTimeout(r, 1500));

        // Step 1: Generate Grid Samples (5 lanes)
        console.log(`[Planner] Generating 5-lane sampling grid (spacing: ${CONFIG.DEFAULT_SAMPLE_SPACING_M}m)...`);
        const grid = generateGridSamples(waypoints, CONFIG.DEFAULT_SAMPLE_SPACING_M);

        // Step 2: Batch Analysis (Cesium interaction)
        const analysis = await analyzeGrid(grid);

        console.log(`[Planner] Analysis: Max Obstacle ${analysis.maxObstacleHeight.toFixed(1)}m, Max Building ${analysis.maxBuildingHeight ? analysis.maxBuildingHeight.toFixed(1) : '0.0'}m`);

        // Get planned altitude (average of waypoint altitudes - purely for reference)
        const plannedAltitude = waypoints.reduce((sum, wp) => sum + wp.alt, 0) / waypoints.length;

        // Step 3: Validate Straight Line (Center Lane)
        // Center lane is at index 2 (offset 0)
        console.log('[Planner] Validating straight-line path (Center Lane)...');
        const centerLanePoints = grid.lanes[2];
        const centerAnalysis = {
            points: centerLanePoints.map(p => ({
                ...p,
                obstacleHeight: p.obstacleHeight,
                terrainHeight: p.terrainHeight,
                buildingHeight: p.buildingHeight || 0
            })),
            maxObstacleHeight: analysis.maxObstacleHeight,
            maxBuildingHeight: analysis.maxBuildingHeight || 0
        };

        const straightValidation = validateFAA(centerAnalysis, plannedAltitude);

        let result;

        if (straightValidation.isValid) {
            // =====================================================
            // STRAIGHT PATH IS VALID
            // =====================================================
            console.log('[Planner] OK: Straight path is valid');

            // Create elevated waypoints for visualization (ground -> cruise)
            // suggestedAltitude is the safe cruise height above obstacles
            const cruiseAlt = straightValidation.suggestedAltitude;
            const visualWaypoints = waypoints.map(wp => ({
                ...wp,
                terrainHeight: wp.alt,  // Original altitude is terrain
                alt: cruiseAlt          // Cruise at suggested safe altitude
            }));

            // Show the green line + safety corridor for direct path
            updateOptimizedRouteVisualization(visualWaypoints);

            result = {
                waypoints: waypoints.map(wp => ({ ...wp })),
                samplePoints: grid.lanes[0].length * 5,
                plannedAltitude,
                analysis: centerAnalysis,
                validation: straightValidation,
                optimized: false,
                timestamp: new Date().toISOString()
            };

        } else {
            // =====================================================
            // BLOCKED - Global A* Optimization
            // =====================================================
            console.log('[Planner] WARN: Straight path blocked. Running Global A* Optimization...');

            if (typeof root.RouteEngine === 'undefined') {
                console.error('[Planner] RouteEngine not loaded - cannot optimize');
                result = {
                    waypoints: waypoints.map(wp => ({ ...wp })),
                    samplePoints: grid.lanes[0].length * 5,
                    plannedAltitude,
                    analysis: centerAnalysis,
                    validation: straightValidation,
                    optimized: false,
                    timestamp: new Date().toISOString()
                };
            } else {
                // Pass the FULL GRID to RouteEngine
                const optimization = root.RouteEngine.optimizeFlightPath(
                    waypoints,  // User waypoints (landing zones)
                    grid        // Full grid with heights
                );

                if (optimization.success) {
                    // SEGMENT VALIDATION: Check for collisions BETWEEN waypoints
                    console.log('[Planner] Running segment collision validation...');
                    const validatedWaypoints = await root.RouteEngine.validateAndFixSegments(
                        optimization.waypoints,
                        viewer
                    );

                    console.log('[Planner] OK: Optimized path generated (A*)');
                    updateOptimizedRouteVisualization(validatedWaypoints);

                    result = {
                        waypoints: validatedWaypoints,
                        originalWaypoints: waypoints.map(wp => ({ ...wp })),
                        samplePoints: grid.lanes[0].length * grid.lanes.length,
                        optimizedPoints: validatedWaypoints.length,
                        plannedAltitude: 0, // Varies
                        analysis: centerAnalysis,
                        validation: {
                            isValid: true,
                            violations: [],
                            suggestedAltitude: 0,
                            suggestedAGL: 0,
                            maxObstacleHeight: analysis.maxObstacleHeight,
                            maxBuildingHeight: analysis.maxBuildingHeight || 0,
                            faaCompliant: true,
                            summary: `APPROVED (A*): Optimal path found with ${optimization.nodesVisited} nodes visited`
                        },
                        optimized: true,
                        optimization: optimization,
                        profileView: optimization.profileView,
                        timestamp: new Date().toISOString()
                    };

                } else {
                    console.log('[Planner] ERROR: No valid A* path found');

                    result = {
                        waypoints: waypoints.map(wp => ({ ...wp })),
                        samplePoints: grid.lanes[0].length * 5,
                        plannedAltitude,
                        analysis: centerAnalysis,
                        validation: {
                            isValid: false,
                            violations: [],
                            summary: `DENIED: No valid path found through obstacles`
                        },
                        optimized: false,
                        timestamp: new Date().toISOString()
                    };
                }
            }
        }

        // Notify UI
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
        if (!routeData.validation.isValid) {
            throw new Error('Cannot submit invalid flight plan');
        }

        console.log('[Planner] ========================================');
        console.log('[Planner] SUBMITTING FLIGHT PLAN TO ATC SERVER');
        console.log('[Planner] ========================================');

        // Configuration
        const DRONE_SPEED_MPS = 15; // 15 meters per second

        // Generate unique flight ID
        const flightId = generateFlightId();

        // Calculate time offsets for each waypoint
        const waypointsWithTime = calculateTimeOffsets(routeData.waypoints, DRONE_SPEED_MPS);

        // Calculate total flight time
        const totalFlightTime = waypointsWithTime.length > 0
            ? waypointsWithTime[waypointsWithTime.length - 1].time_offset
            : 0;

        // Calculate total distance
        let totalDistance = 0;
        for (let i = 1; i < routeData.waypoints.length; i++) {
            totalDistance += calculateDistance(routeData.waypoints[i - 1], routeData.waypoints[i]);
        }

        // Generate high-fidelity 4D trajectory (1m spacing for conflict detection)
        const trajectoryLog = densifyRoute(routeData.waypoints, DRONE_SPEED_MPS);

        // Construct the payload matching backend schema
        const payload = {
            flight_id: flightId,
            waypoints: waypointsWithTime,
            trajectory_log: trajectoryLog,  // High-fidelity 1m-spaced trajectory
            metadata: {
                drone_speed_mps: DRONE_SPEED_MPS,
                total_distance_m: Math.round(totalDistance),
                total_flight_time_s: Math.round(totalFlightTime),
                trajectory_points: trajectoryLog.length,
                planned_altitude_m: routeData.plannedAltitude,
                max_obstacle_height_m: routeData.analysis.maxObstacleHeight,
                faa_compliant: routeData.validation.faaCompliant,
                submitted_at: new Date().toISOString()
            }
        };

        if (selectedDroneId) {
            payload.metadata.drone_id = selectedDroneId;
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
                throw new Error(`ATC Server returned ${response.status}: ${text || response.statusText}`);
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

        // FAA Validation
        validateFAA,

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

        // Utilities
        flyTo,
        getViewer: () => viewer,

        // Configuration
        CONFIG
    };

})(typeof window !== 'undefined' ? window : this);
