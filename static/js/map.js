/**
 * Map Page - Full-Featured Live Tracking
 * Ported from spotlight.ejs with all 3D visualization features
 */

(function () {
    'use strict';

    const statusUtils = window.ATCStatus || {
        getStatusClass: () => 'online'
    };

    // ========================================================================
    // Configuration
    // ========================================================================

    const CesiumConfig = window.__CESIUM_CONFIG__ || {};

    const CONFIG = {
        ATC_SERVER_URL: window.__ATC_API_BASE__ || 'http://localhost:3000',
        ATC_WS_BASE: window.__ATC_WS_BASE__ || '',
        ATC_WS_TOKEN: window.__ATC_WS_TOKEN__ || '',
        CESIUM_ION_TOKEN: CesiumConfig.ionToken || '',
        GOOGLE_3D_TILES_ASSET_ID: Number(CesiumConfig.google3dTilesAssetId) || 0,
        DEFAULT_VIEW: { lat: 33.6846, lon: -117.8265, height: 2000 },
        MAX_TRAIL_POINTS: 60,
        HEADING_ARROW_LENGTH_M: 100,
        WS_RETRY_MS: 5000,
        SHOW_EXTERNAL_TRAFFIC: true,
        REFRESH_INTERVALS: {
            drones: 1000,
            conflicts: 2000,
            flightPlans: 5000,
            geofences: 10000,
            health: 5000,
            conformance: 8000,
            daa: 4000
        }
    };

    // ========================================================================
    // State
    // ========================================================================

    let viewer = null;
    let realtimeSocket = null;
    let realtimeRetryTimer = null;
    let wsReconnectAttempts = 0;
    let wsConnectionStableTimer = null;
    let wsLastConnectTime = null;

    // Drone tracking
    const droneEntities = new Map();  // droneId -> Cesium.Entity
    const droneTrails = new Map();    // droneId -> [Cartesian3]
    const droneData = new Map();      // droneId -> {lat, lon, alt, speed, heading}
    const headingArrows = new Map();  // droneId -> arrow entity
    let visibleDroneIds = new Set();
    const conformanceStatuses = new Map(); // droneId -> status payload
    const daaAdvisories = new Map(); // advisoryId -> advisory
    const daaByDrone = new Map(); // droneId -> primary advisory

    // Conflicts
    const conflictEntities = new Map();  // conflictId -> entity
    let activeConflicts = [];

    // Geofences
    const geofenceEntities = new Map();  // geofenceId -> entity

    // Flight plans
    const flightPlans = new Map();       // droneId -> plan
    let selectedRouteEntity = null;

    // Camera
    let cameraMode = 'free';  // free, orbit, cockpit
    let trackedDroneId = null;
    let selectedDroneId = null;
    let ridViewTimer = null;
    let lastRidViewKey = null;

    const MAX_ROUTE_POINTS = 400;

    // Time of day
    let currentTOD = 'realtime';

    // Orbit camera state
    let orbitHeading = 0;
    let orbitPitch = Cesium.Math.toRadians(-35);
    let orbitRange = 600;
    const ORBIT_PITCH_MIN = Cesium.Math.toRadians(-80);
    const ORBIT_PITCH_MAX = Cesium.Math.toRadians(-10);
    const ORBIT_RANGE_MIN = 80;
    const ORBIT_RANGE_MAX = 8000;
    const ORBIT_STEP_HEADING = Cesium.Math.toRadians(10);
    const ORBIT_STEP_PITCH = Cesium.Math.toRadians(5);
    const ORBIT_STEP_RANGE = 150;

    // ========================================================================
    // Initialization
    // ========================================================================

    async function initViewer() {
        console.log('[Map] Initializing Cesium viewer...');

        Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;

        viewer = new Cesium.Viewer('cesiumContainer', {
            globe: new Cesium.Globe(Cesium.Ellipsoid.WGS84),
            skyAtmosphere: new Cesium.SkyAtmosphere(),
            geocoder: false,
            homeButton: false,
            baseLayerPicker: false,
            infoBox: false,
            sceneModePicker: false,
            animation: false,
            selectionIndicator: true,
            fullscreenButton: false,
            timeline: false,
            navigationHelpButton: false,
            shadows: false
        });

        // Enable dynamic lighting
        viewer.scene.globe.enableLighting = true;
        viewer.scene.sun.show = true;
        viewer.scene.moon.show = true;
        viewer.scene.light = new Cesium.SunLight();
        viewer.scene.globe.dynamicAtmosphereLighting = true;
        viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;

        // Set clock to real-time
        viewer.clock.currentTime = Cesium.JulianDate.now();
        viewer.clock.shouldAnimate = true;
        viewer.clock.multiplier = 1;

        // Load Google Photorealistic 3D Tiles
        try {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.GOOGLE_3D_TILES_ASSET_ID);
            viewer.scene.primitives.add(tileset);
            console.log('[Map] Google Photorealistic 3D Tiles loaded');
        } catch (error) {
            console.error('[Map] Failed to load 3D Tiles:', error);
            // Fallback to ESRI imagery
            try {
                const esriImagery = new Cesium.UrlTemplateImageryProvider({
                    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                    credit: 'Esri'
                });
                viewer.imageryLayers.addImageryProvider(esriImagery);
                console.log('[Map] Fallback: Esri Imagery loaded');
            } catch (e) {
                console.error('[Map] Fallback imagery also failed', e);
            }
        }

        // Set default view to Irvine
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(CONFIG.DEFAULT_VIEW.lon, CONFIG.DEFAULT_VIEW.lat, CONFIG.DEFAULT_VIEW.height),
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-45),
                roll: 0
            }
        });

        // Set up event handlers
        setupEventHandlers();

        // Start polling loops
        startPollingLoops();
        startRealtime();
        scheduleRidViewUpdate();

        // Check for tracking param from URL
        const params = new URLSearchParams(window.location.search);
        const trackId = params.get('track');
        if (trackId) {
            trackedDroneId = trackId;
            selectedDroneId = trackId;
        }

        console.log('[Map] Viewer ready');
    }

    function setupEventHandlers() {
        // Entity selection
        viewer.selectedEntityChanged.addEventListener((entity) => {
            // Remove previous route visualization
            if (selectedRouteEntity) {
                viewer.entities.remove(selectedRouteEntity);
                selectedRouteEntity = null;
            }

            if (entity && flightPlans.has(entity.id)) {
                // Show flight plan route
                const plan = flightPlans.get(entity.id);
                const route = getPlanRouteWaypoints(plan);
                const positions = route.map(wp =>
                    Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.altitude_m)
                );

                selectedRouteEntity = viewer.entities.add({
                    polyline: {
                        positions: positions,
                        width: 2,
                        material: new Cesium.PolylineDashMaterialProperty({
                            color: Cesium.Color.fromCssColorString('#10b981'),
                            dashLength: 16.0
                        })
                    }
                });
            }

            // Update camera tracking
            if (entity && droneEntities.has(entity.id)) {
                trackedDroneId = entity.id;
                selectedDroneId = entity.id;
                updateSelectedDronePanel(droneData.get(entity.id));
                showSelectedDronePanel(true);

                if (cameraMode === 'orbit') {
                    viewer.trackedEntity = undefined;
                    syncOrbitCamera();
                }
            } else {
                showSelectedDronePanel(false);
                trackedDroneId = null;
                if (cameraMode === 'orbit') {
                    viewer.trackedEntity = undefined;
                }
            }
        });

        viewer.camera.moveEnd.addEventListener(() => {
            scheduleRidViewUpdate();
        });

        // Cockpit camera update on tick
        viewer.clock.onTick.addEventListener((clock) => {
            if (cameraMode === 'orbit') {
                syncOrbitCamera(clock.currentTime);
                return;
            }
            if (cameraMode === 'cockpit' && trackedDroneId && droneEntities.has(trackedDroneId)) {
                try {
                    const entity = droneEntities.get(trackedDroneId);
                    if (!entity || !entity.position) return;

                    const position = entity.position.getValue(clock.currentTime);
                    if (!position) return;

                    let heading = 0;
                    const data = droneData.get(trackedDroneId);
                    if (data && data.heading) {
                        heading = Cesium.Math.toRadians(data.heading);
                    }

                    const pitch = Cesium.Math.toRadians(-10);

                    viewer.camera.setView({
                        destination: position,
                        orientation: {
                            heading: heading,
                            pitch: pitch,
                            roll: 0
                        }
                    });
                } catch (e) {
                    console.warn('[Map] Cockpit camera error:', e);
                }
            }
        });
    }

    function scheduleRidViewUpdate() {
        if (!viewer) return;
        if (ridViewTimer) clearTimeout(ridViewTimer);
        ridViewTimer = setTimeout(pushRidViewUpdate, 750);
    }

    function computeRidViewBBox() {
        if (!viewer) return null;
        const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
        if (!rectangle) return null;

        let minLat = Cesium.Math.toDegrees(rectangle.south);
        let maxLat = Cesium.Math.toDegrees(rectangle.north);
        let minLon = Cesium.Math.toDegrees(rectangle.west);
        let maxLon = Cesium.Math.toDegrees(rectangle.east);

        if (maxLon < minLon) {
            minLon = -180;
            maxLon = 180;
        }

        minLat = Math.max(-90, Math.min(90, minLat));
        maxLat = Math.max(-90, Math.min(90, maxLat));
        minLon = Math.max(-180, Math.min(180, minLon));
        maxLon = Math.max(-180, Math.min(180, maxLon));

        return {
            min_lat: minLat,
            min_lon: minLon,
            max_lat: maxLat,
            max_lon: maxLon
        };
    }

    async function pushRidViewUpdate() {
        const view = computeRidViewBBox();
        if (!view) return;

        const viewKey = [
            view.min_lat.toFixed(5),
            view.min_lon.toFixed(5),
            view.max_lat.toFixed(5),
            view.max_lon.toFixed(5)
        ].join(',');

        if (viewKey === lastRidViewKey) return;
        lastRidViewKey = viewKey;

        try {
            await fetch(`${CONFIG.ATC_SERVER_URL}/v1/rid/view`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(view)
            });
        } catch (error) {
            console.warn('[Map] RID view sync failed:', error);
        }
    }

    // ========================================================================
    // Polling Loops
    // ========================================================================

    function startPollingLoops() {
        // Drones
        fetchDrones();
        setInterval(fetchDrones, CONFIG.REFRESH_INTERVALS.drones);

        // Conflicts
        fetchConflicts();
        setInterval(fetchConflicts, CONFIG.REFRESH_INTERVALS.conflicts);

        // Flight plans
        fetchFlightPlans();
        setInterval(fetchFlightPlans, CONFIG.REFRESH_INTERVALS.flightPlans);

        // Geofences
        fetchGeofences();
        setInterval(fetchGeofences, CONFIG.REFRESH_INTERVALS.geofences);

        // Conformance
        fetchConformance();
        setInterval(fetchConformance, CONFIG.REFRESH_INTERVALS.conformance);

        // DAA
        fetchDaa();
        setInterval(fetchDaa, CONFIG.REFRESH_INTERVALS.daa);
    }

    // ========================================================================
    // Realtime Streaming
    // ========================================================================

    function startRealtime() {
        if (typeof WebSocket === 'undefined') {
            console.warn('[Map] WebSocket not available in this browser.');
            return;
        }

        const wsUrl = resolveWsUrl();
        if (!wsUrl) {
            console.warn('[Map] Realtime streaming disabled (set ATC_WS_URL to enable).');
            return;
        }

        connectRealtime(wsUrl);
    }

    function connectRealtime(wsUrl) {
        if (realtimeSocket && realtimeSocket.readyState === WebSocket.OPEN) {
            return;
        }
        if (realtimeSocket) {
            realtimeSocket.close();
        }

        // Clear any pending stability timer from previous connection
        if (wsConnectionStableTimer) {
            clearTimeout(wsConnectionStableTimer);
            wsConnectionStableTimer = null;
        }

        try {
            realtimeSocket = new WebSocket(wsUrl);
        } catch (error) {
            console.warn('[Map] Failed to start realtime WebSocket:', error);
            scheduleRealtimeReconnect(wsUrl);
            return;
        }

        realtimeSocket.onopen = () => {
            console.log('[Map] Realtime stream connected.');
            wsLastConnectTime = Date.now();

            if (realtimeRetryTimer) {
                clearTimeout(realtimeRetryTimer);
                realtimeRetryTimer = null;
            }

            // Reset attempts only after connection has been stable for 5 seconds
            wsConnectionStableTimer = setTimeout(() => {
                if (realtimeSocket && realtimeSocket.readyState === WebSocket.OPEN) {
                    console.log('[Map] WebSocket connection stable, resetting reconnect attempts.');
                    wsReconnectAttempts = 0;
                }
                wsConnectionStableTimer = null;
            }, 5000);
        };

        realtimeSocket.onmessage = (event) => {
            if (!event?.data) return;
            try {
                const payload = JSON.parse(event.data);
                if (!payload?.drone_id) return;
                const ownerId = getOwnerFilterId();
                if (ownerId) {
                    if (!payload.owner_id) return;
                    if (payload.owner_id !== ownerId) return;
                }
                updateDronePosition(
                    payload.drone_id,
                    payload.lon,
                    payload.lat,
                    payload.altitude_m,
                    payload.heading_deg,
                    payload.speed_mps,
                    payload.status,
                    payload.traffic_source || 'local'
                );
            } catch (error) {
                console.warn('[Map] Realtime message parse failed:', error);
            }
        };

        realtimeSocket.onclose = () => {
            console.warn('[Map] Realtime stream disconnected. Retrying with backoff...');
            // Cancel stability timer if connection closes before 5 seconds
            if (wsConnectionStableTimer) {
                clearTimeout(wsConnectionStableTimer);
                wsConnectionStableTimer = null;
            }
            scheduleRealtimeReconnect(wsUrl);
        };

        realtimeSocket.onerror = () => {
            if (realtimeSocket) {
                realtimeSocket.close();
            }
        };
    }

    /**
     * Schedule WebSocket reconnection with exponential backoff and jitter.
     * Formula: delay = min(maxDelay, baseDelay * 2^attempts) + jitter
     * 
     * This prevents thundering herd when multiple clients reconnect simultaneously.
     */
    function scheduleRealtimeReconnect(wsUrl) {
        if (realtimeRetryTimer) return;

        const baseDelay = 1000;    // 1 second
        const maxDelay = 30000;    // 30 seconds
        const jitter = Math.random() * 500;  // 0-500ms random jitter

        // Calculate delay with exponential backoff
        const exponentialDelay = Math.min(maxDelay, baseDelay * Math.pow(2, wsReconnectAttempts));
        const delay = exponentialDelay + jitter;

        console.log(`[Map] Reconnecting in ${Math.round(delay)}ms (attempt ${wsReconnectAttempts + 1})`);

        wsReconnectAttempts++;

        realtimeRetryTimer = setTimeout(() => {
            realtimeRetryTimer = null;
            connectRealtime(wsUrl);
        }, delay);
    }

    function resolveWsUrl() {
        let base = CONFIG.ATC_WS_BASE;
        if (!base) {
            if (/^https?:\/\//i.test(CONFIG.ATC_SERVER_URL)) {
                base = CONFIG.ATC_SERVER_URL;
            } else {
                return '';
            }
        }

        if (/^https?:\/\//i.test(base)) {
            base = base.replace(/^http/i, 'ws');
        } else if (!/^wss?:\/\//i.test(base)) {
            return '';
        }

        return appendWsPath(base);
    }

    function appendWsPath(base) {
        if (!base) return '';
        let url;
        try {
            url = new URL(base);
        } catch (error) {
            console.warn('[Map] Invalid WS base URL:', error);
            return '';
        }

        if (!url.pathname.includes('/v1/ws')) {
            if (url.pathname.endsWith('/')) {
                url.pathname = `${url.pathname}v1/ws`;
            } else if (url.pathname === '') {
                url.pathname = '/v1/ws';
            } else {
                url.pathname = `${url.pathname}/v1/ws`;
            }
        }

        const ownerId = getOwnerFilterId();
        if (ownerId && !url.searchParams.has('owner_id')) {
            url.searchParams.set('owner_id', ownerId);
        }
        if (CONFIG.ATC_WS_TOKEN && !url.searchParams.has('token')) {
            url.searchParams.set('token', CONFIG.ATC_WS_TOKEN);
        }

        return url.toString();
    }

    function getOwnerFilterId() {
        const user = window.APP_USER;
        if (!user || user.role === 'authority') return null;
        return user.id || null;
    }

    function isExternalSource(source) {
        return !!source && source !== 'local';
    }

    function getTrafficSilhouetteColor(source) {
        return isExternalSource(source) ? Cesium.Color.DODGERBLUE : Cesium.Color.CYAN;
    }

    function getTrafficTrailColor(source) {
        return isExternalSource(source) ? Cesium.Color.SKYBLUE : Cesium.Color.YELLOW;
    }

    function getTrafficArrowColor(source) {
        return isExternalSource(source) ? Cesium.Color.SKYBLUE : Cesium.Color.CYAN;
    }

    // ========================================================================
    // Drone Visualization
    // ========================================================================

    async function fetchDrones() {
        try {
            const params = new URLSearchParams();
            const ownerId = getOwnerFilterId();
            if (ownerId) {
                params.set('owner_id', ownerId);
            }
            if (CONFIG.SHOW_EXTERNAL_TRAFFIC) {
                params.set('include_external', 'true');
            }
            const endpoint = `/v1/traffic${params.toString() ? `?${params.toString()}` : ''}`;
            console.log('[Map] Fetching traffic from:', CONFIG.ATC_SERVER_URL + endpoint);
            const response = await fetch(CONFIG.ATC_SERVER_URL + endpoint, {
                credentials: 'same-origin'
            });
            if (!response.ok) {
                console.error('[Map] Drone fetch failed:', response.status, response.statusText);
                return;
            }

            const drones = await response.json();
            console.log('[Map] Received', drones.length, 'tracks:', drones.map(d => d.drone_id));

            // Update status bar
            const droneCountEl = document.getElementById('droneCountValue');
            const conflictCountEl = document.getElementById('conflictCountValue');
            if (droneCountEl) droneCountEl.textContent = drones.length;
            if (conflictCountEl) conflictCountEl.textContent = activeConflicts.length;

            // Track which drones we've seen this update
            const currentIds = new Set();

            drones.forEach(drone => {
                currentIds.add(drone.drone_id);
                updateDronePosition(
                    drone.drone_id,
                    drone.lon,
                    drone.lat,
                    drone.altitude_m,
                    drone.heading_deg,
                    drone.speed_mps,
                    drone.status,
                    drone.traffic_source
                );
            });

            // Remove stale drones
            for (const [id, entity] of droneEntities) {
                if (!currentIds.has(id)) {
                    viewer.entities.remove(entity);
                    droneEntities.delete(id);
                    droneTrails.delete(id);
                    droneData.delete(id);

                    // Remove heading arrow
                    if (headingArrows.has(id)) {
                        viewer.entities.remove(headingArrows.get(id));
                        headingArrows.delete(id);
                    }
                }
            }

            visibleDroneIds = currentIds;

            // Update sidebar list
            updateDroneList(drones);

        } catch (e) {
            console.error('[Map] Drone fetch error:', e.message);
        }
    }

    async function fetchConformance() {
        try {
            const params = new URLSearchParams();
            const ownerId = getOwnerFilterId();
            if (ownerId) params.set('owner_id', ownerId);
            const endpoint = `/v1/conformance${params.toString() ? `?${params.toString()}` : ''}`;
            const response = await fetch(CONFIG.ATC_SERVER_URL + endpoint, {
                credentials: 'same-origin'
            });
            if (!response.ok) {
                console.error('[Map] Conformance fetch failed:', response.status, response.statusText);
                return;
            }

            const statuses = await response.json();
            conformanceStatuses.clear();
            statuses.forEach((entry) => {
                conformanceStatuses.set(entry.drone_id, entry);
            });
        } catch (e) {
            console.error('[Map] Conformance fetch error:', e.message);
        }
    }

    async function fetchDaa() {
        try {
            const params = new URLSearchParams();
            const ownerId = getOwnerFilterId();
            if (ownerId) params.set('owner_id', ownerId);
            params.set('active_only', 'true');

            const endpoint = `/v1/daa${params.toString() ? `?${params.toString()}` : ''}`;
            const response = await fetch(CONFIG.ATC_SERVER_URL + endpoint, {
                credentials: 'same-origin'
            });
            if (!response.ok) {
                console.error('[Map] DAA fetch failed:', response.status, response.statusText);
                return;
            }

            const advisories = await response.json();
            updateDaaState(advisories);
            updateDaaList(advisories);
            updateSelectedDaaFields();
        } catch (e) {
            console.error('[Map] DAA fetch error:', e.message);
        }
    }

    function updateDronePosition(droneId, lon, lat, altMeters, heading, speed, status, trafficSource) {
        try {
            const validLon = Number(lon) || 0;
            const validLat = Number(lat) || 0;
            const validAlt = Number(altMeters) || 0;
            const source = trafficSource || 'local';
            const statusValue = status || 'active';
            const external = isExternalSource(source);

            if (validLon === 0 && validLat === 0) return;

            const position = Cesium.Cartesian3.fromDegrees(validLon, validLat, validAlt);

            // Update trail history
            if (!droneTrails.has(droneId)) {
                droneTrails.set(droneId, []);
            }
            const trail = droneTrails.get(droneId);
            trail.push(position);
            if (trail.length > CONFIG.MAX_TRAIL_POINTS) {
                trail.shift();
            }

            // Description HTML
            const description = `
                <table style="font-size: 12px;">
                    <tr><td>ID:</td><td><strong>${droneId}</strong></td></tr>
                    <tr><td>Source:</td><td>${external ? 'Remote ID' : 'Local'}</td></tr>
                    <tr><td>Speed:</td><td>${(speed || 0).toFixed(1)} m/s</td></tr>
                    <tr><td>Heading:</td><td>${(heading || 0).toFixed(0)}°</td></tr>
                    <tr><td>Altitude:</td><td>${altMeters.toFixed(0)} m</td></tr>
                    <tr><td>Position:</td><td>${lat.toFixed(5)}, ${lon.toFixed(5)}</td></tr>
                </table>
            `;

            if (!droneEntities.has(droneId)) {
                // Create new drone entity with 3D model
                const headingRad = Cesium.Math.toRadians(heading || 0);
                const hpr = new Cesium.HeadingPitchRoll(headingRad, 0, 0);
                const orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
                const silhouetteColor = getTrafficSilhouetteColor(source);
                const trailColor = getTrafficTrailColor(source);

                const entity = viewer.entities.add({
                    id: droneId,
                    name: `Drone ${droneId}`,
                    position: position,
                    orientation: orientation,
                    // 3D Drone Model
                    model: {
                        uri: '/assets/models/drone.glb',
                        minimumPixelSize: 32,
                        maximumScale: 200,
                        scale: 0.5,
                        silhouetteColor: silhouetteColor,
                        silhouetteSize: 1.5,
                        colorBlendMode: Cesium.ColorBlendMode.HIGHLIGHT,
                        colorBlendAmount: 0.0
                    },
                    label: {
                        text: `${droneId}\n${(speed || 0).toFixed(1)} m/s`,
                        font: '12px Inter, sans-serif',
                        fillColor: Cesium.Color.WHITE,
                        showBackground: true,
                        backgroundColor: Cesium.Color.fromCssColorString('#0f172a').withAlpha(0.7),
                        backgroundPadding: new Cesium.Cartesian2(4, 4),
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        pixelOffset: new Cesium.Cartesian2(0, -40),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5000)
                    },
                    description: description,
                    // Trail polyline
                    polyline: {
                        positions: new Cesium.CallbackProperty(() => droneTrails.get(droneId), false),
                        width: 3,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.2,
                            color: trailColor
                        })
                    }
                });

                droneEntities.set(droneId, entity);
                console.log(`[Map] Created drone: ${droneId}`);

            } else {
                // Update existing drone
                const entity = droneEntities.get(droneId);
                entity.position = position;

                const headingRad = Cesium.Math.toRadians(heading || 0);
                const hpr = new Cesium.HeadingPitchRoll(headingRad, 0, 0);
                entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(position, hpr);

                entity.description = description;
                entity.label.text = `${droneId}\n${(speed || 0).toFixed(1)} m/s`;
            }

            // Store data
            droneData.set(droneId, { lat: validLat, lon: validLon, alt: validAlt, speed, heading, status: statusValue, source, external });

            // Update heading arrow
            const headingRad = Cesium.Math.toRadians(heading || 0);
            const arrowEndLat = validLat + (CONFIG.HEADING_ARROW_LENGTH_M / 111320) * Math.cos(headingRad);
            const arrowEndLon = validLon + (CONFIG.HEADING_ARROW_LENGTH_M / (111320 * Math.cos(validLat * Math.PI / 180))) * Math.sin(headingRad);
            const arrowEnd = Cesium.Cartesian3.fromDegrees(arrowEndLon, arrowEndLat, validAlt);

            if (!headingArrows.has(droneId)) {
                const arrowColor = getTrafficArrowColor(source);
                const arrow = viewer.entities.add({
                    id: `arrow-${droneId}`,
                    polyline: {
                        positions: [position, arrowEnd],
                        width: 6,
                        material: new Cesium.PolylineArrowMaterialProperty(arrowColor)
                    }
                });
                headingArrows.set(droneId, arrow);
            } else {
                const arrow = headingArrows.get(droneId);
                arrow.polyline.positions = [position, arrowEnd];
            }

            // Update selected drone panel if this is the selected drone
            if (selectedDroneId === droneId) {
                updateSelectedDronePanel(droneData.get(droneId));
            }

        } catch (error) {
            console.error('[Map] Error updating drone position:', error);
        }
    }

    // ========================================================================
    // Conflict Visualization
    // ========================================================================

    async function fetchConflicts() {
        try {
            const params = new URLSearchParams();
            const ownerId = getOwnerFilterId();
            if (ownerId) params.set('owner_id', ownerId);
            const endpoint = `/v1/conflicts${params.toString() ? `?${params.toString()}` : ''}`;
            const response = await fetch(CONFIG.ATC_SERVER_URL + endpoint, {
                credentials: 'same-origin'
            });
            if (!response.ok) return;

            let conflicts = await response.json();
            if (ownerId && visibleDroneIds.size) {
                conflicts = conflicts.filter(conflict =>
                    visibleDroneIds.has(conflict.drone1_id) || visibleDroneIds.has(conflict.drone2_id)
                );
            }
            activeConflicts = conflicts;
            renderConflicts(conflicts);
            updateConflictsList(conflicts);

        } catch (e) {
            // Server might not be running
        }
    }

    function renderConflicts(conflicts) {
        // Remove old conflict entities
        const currentConflictIds = new Set(conflicts.map(c => `${c.drone1_id}-${c.drone2_id}`));
        for (const [id, entity] of conflictEntities) {
            if (!currentConflictIds.has(id)) {
                viewer.entities.remove(entity);
                conflictEntities.delete(id);
            }
        }

        // Add/update conflict lines
        for (const conflict of conflicts) {
            const conflictId = `${conflict.drone1_id}-${conflict.drone2_id}`;

            const drone1 = droneEntities.get(conflict.drone1_id);
            const drone2 = droneEntities.get(conflict.drone2_id);
            if (!drone1 || !drone2) continue;

            const pos1 = drone1.position?.getValue(viewer.clock.currentTime);
            const pos2 = drone2.position?.getValue(viewer.clock.currentTime);
            if (!pos1 || !pos2) continue;

            // Color based on severity
            let lineColor, lineWidth;
            if (conflict.severity === 'critical') {
                lineColor = Cesium.Color.RED;
                lineWidth = 4;
            } else if (conflict.severity === 'warning') {
                lineColor = Cesium.Color.ORANGE;
                lineWidth = 3;
            } else {
                lineColor = Cesium.Color.YELLOW;
                lineWidth = 2;
            }

            if (conflictEntities.has(conflictId)) {
                const entity = conflictEntities.get(conflictId);
                entity.polyline.positions = [pos1, pos2];
            } else {
                const entity = viewer.entities.add({
                    id: `conflict-${conflictId}`,
                    polyline: {
                        positions: [pos1, pos2],
                        width: lineWidth,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.3,
                            color: lineColor
                        })
                    }
                });
                conflictEntities.set(conflictId, entity);
                console.log(`[Map] Conflict: ${conflict.severity.toUpperCase()} ${conflict.drone1_id} <-> ${conflict.drone2_id}`);
            }

            // Color drone models based on conflict
            if (conflict.severity === 'critical') {
                if (drone1.model) drone1.model.silhouetteColor = Cesium.Color.RED;
                if (drone2.model) drone2.model.silhouetteColor = Cesium.Color.RED;
            } else if (conflict.severity === 'warning') {
                if (drone1.model) drone1.model.silhouetteColor = Cesium.Color.ORANGE;
                if (drone2.model) drone2.model.silhouetteColor = Cesium.Color.ORANGE;
            }
        }

        // Reset non-conflicting drones
        const conflictingDrones = new Set();
        conflicts.forEach(c => {
            conflictingDrones.add(c.drone1_id);
            conflictingDrones.add(c.drone2_id);
        });
        for (const [id, entity] of droneEntities) {
            if (!conflictingDrones.has(id) && entity.model) {
                const source = droneData.get(id)?.source || 'local';
                entity.model.silhouetteColor = getTrafficSilhouetteColor(source);
            }
        }
    }

    // ========================================================================
    // Geofence Visualization
    // ========================================================================

    async function fetchGeofences() {
        try {
            const response = await fetch(CONFIG.ATC_SERVER_URL + '/v1/geofences', {
                credentials: 'same-origin'
            });
            if (!response.ok) return;

            const geofences = await response.json();
            renderGeofences(geofences);

        } catch (e) {
            // Server might not be running
        }
    }

    function renderGeofences(geofences) {
        // Remove old geofences
        const currentIds = new Set(geofences.map(g => g.id));
        for (const [id, entity] of geofenceEntities) {
            if (!currentIds.has(id)) {
                viewer.entities.remove(entity);
                geofenceEntities.delete(id);
            }
        }

        for (const geofence of geofences) {
            if (geofenceEntities.has(geofence.id)) continue;

            // Convert polygon to Cesium positions
            const positions = geofence.polygon.map(([lat, lon]) =>
                Cesium.Cartesian3.fromDegrees(lon, lat, geofence.upper_altitude_m)
            );

            // Color based on type
            let fillColor, outlineColor;
            switch (geofence.geofence_type) {
                case 'no_fly_zone':
                    fillColor = Cesium.Color.RED.withAlpha(0.3);
                    outlineColor = Cesium.Color.RED;
                    break;
                case 'restricted_area':
                    fillColor = Cesium.Color.ORANGE.withAlpha(0.25);
                    outlineColor = Cesium.Color.ORANGE;
                    break;
                case 'temporary_restriction':
                    fillColor = Cesium.Color.YELLOW.withAlpha(0.2);
                    outlineColor = Cesium.Color.YELLOW;
                    break;
                default:
                    fillColor = Cesium.Color.BLUE.withAlpha(0.15);
                    outlineColor = Cesium.Color.BLUE;
            }

            const entity = viewer.entities.add({
                id: `geofence-${geofence.id}`,
                name: geofence.name,
                polygon: {
                    hierarchy: positions,
                    height: geofence.lower_altitude_m,
                    extrudedHeight: geofence.upper_altitude_m,
                    material: fillColor,
                    outline: true,
                    outlineColor: outlineColor,
                    outlineWidth: 2
                }
            });

            geofenceEntities.set(geofence.id, entity);
            console.log(`[Map] Geofence: ${geofence.name} (${geofence.geofence_type})`);
        }
    }

    // ========================================================================
    // Flight Plans
    // ========================================================================

    async function fetchFlightPlans() {
        try {
            const params = new URLSearchParams();
            const ownerId = getOwnerFilterId();
            if (ownerId) params.set('owner_id', ownerId);
            const endpoint = `/v1/flights${params.toString() ? `?${params.toString()}` : ''}`;
            const response = await fetch(CONFIG.ATC_SERVER_URL + endpoint, {
                credentials: 'same-origin'
            });
            if (!response.ok) return;

            const plans = await response.json();
            plans.forEach(plan => {
                flightPlans.set(plan.drone_id, plan);
            });

        } catch (e) {
            // Server might not be running
        }
    }

    function normalizeRoutePoint(point) {
        if (!point) return null;
        const lat = Number(point.lat);
        const lon = Number(point.lon);
        const altitude = Number(point.altitude_m ?? point.alt);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
            lat,
            lon,
            altitude_m: Number.isFinite(altitude) ? altitude : 0
        };
    }

    function sampleWaypoints(points, maxPoints) {
        if (!Array.isArray(points) || points.length === 0) return [];
        const normalized = points.map(normalizeRoutePoint).filter(Boolean);
        if (normalized.length <= maxPoints) return normalized;

        const step = Math.ceil(normalized.length / maxPoints);
        const sampled = [];
        for (let i = 0; i < normalized.length; i += step) {
            sampled.push(normalized[i]);
        }
        const last = normalized[normalized.length - 1];
        if (sampled.length && sampled[sampled.length - 1] !== last) {
            sampled.push(last);
        }
        return sampled;
    }

    function getPlanRouteWaypoints(plan) {
        if (!plan) return [];
        if (Array.isArray(plan.trajectory_log) && plan.trajectory_log.length) {
            return sampleWaypoints(plan.trajectory_log, MAX_ROUTE_POINTS);
        }
        if (Array.isArray(plan.waypoints)) {
            return plan.waypoints.map(normalizeRoutePoint).filter(Boolean);
        }
        return [];
    }

    // ========================================================================
    // UI Updates
    // ========================================================================

    function updateDroneList(drones) {
        const container = document.getElementById('activeDronesList');
        if (!container) return;

        if (!drones || drones.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 16px;">
                    <div class="empty-state-text text-muted">No active drones</div>
                </div>
            `;
            return;
        }

        container.innerHTML = drones.map(drone => {
            const isExternal = isExternalSource(drone.traffic_source);
            const conformance = conformanceStatuses.get(drone.drone_id);
            const conformanceStatus = conformance?.status || 'unknown';
            const conformanceClass = getConformanceClass(conformanceStatus);
            const daa = daaByDrone.get(drone.drone_id);
            const daaBadge = daa
                ? `<span class="status-badge ${getDaaClass(daa.severity)}" style="margin-left: 4px;">${formatDaaSeverity(daa.severity)}</span>`
                : '';
            const sourceBadge = isExternal
                ? `<span class="status-badge pending" style="margin-left: 4px;">RID</span>`
                : '';
            const statusLine = isExternal
                ? `<span class="status-badge warn">external</span>${sourceBadge}`
                : `<span class="status-badge ${conformanceClass}">${conformanceStatus}</span>${daaBadge}`;
            return `
                <div class="drone-track-item ${selectedDroneId === drone.drone_id ? 'selected' : ''}" 
                     onclick="MapControl.selectDrone('${drone.drone_id}')">
                    <span class="status-dot ${getStatusClass(drone.status)}"></span>
                    <div class="list-item-content">
                        <div class="list-item-title" style="font-size: 13px;">${drone.drone_id}</div>
                        <div class="list-item-subtitle" style="font-size: 11px;">${drone.altitude_m.toFixed(0)}m | ${drone.speed_mps.toFixed(1)} m/s</div>
                        <div class="list-item-subtitle" style="font-size: 11px;">
                            ${statusLine}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function updateConflictsList(conflicts) {
        const container = document.getElementById('conflictsList');
        if (!container) return;

        if (!conflicts || conflicts.length === 0) {
            container.innerHTML = `
                <div class="status-badge online" style="margin: 8px 0;">
                    <span class="status-dot online"></span>
                    <span>All Clear</span>
                </div>
            `;
            return;
        }

        container.innerHTML = conflicts.map(c => `
            <div class="list-item" style="padding: 8px; background: rgba(239,68,68,0.1); border-color: var(--accent-red); margin-bottom: 4px;">
                <div class="list-item-content">
                    <div class="list-item-title text-danger" style="font-size: 12px;">
                        ${c.drone1_id} - ${c.drone2_id}
                    </div>
                    <div class="list-item-subtitle">${c.distance_m.toFixed(0)}m apart</div>
                </div>
            </div>
        `).join('');
    }

    function updateDaaState(advisories) {
        daaAdvisories.clear();
        daaByDrone.clear();

        if (!Array.isArray(advisories)) {
            return;
        }

        for (const advisory of advisories) {
            if (!advisory || !advisory.advisory_id || !advisory.drone_id) continue;
            daaAdvisories.set(advisory.advisory_id, advisory);

            const existing = daaByDrone.get(advisory.drone_id);
            if (!existing) {
                daaByDrone.set(advisory.drone_id, advisory);
                continue;
            }

            const nextRank = getDaaSeverityRank(advisory.severity);
            const currentRank = getDaaSeverityRank(existing.severity);
            if (nextRank > currentRank) {
                daaByDrone.set(advisory.drone_id, advisory);
                continue;
            }

            if (nextRank === currentRank) {
                const nextUpdated = Date.parse(advisory.updated_at || '') || 0;
                const currentUpdated = Date.parse(existing.updated_at || '') || 0;
                if (nextUpdated > currentUpdated) {
                    daaByDrone.set(advisory.drone_id, advisory);
                }
            }
        }
    }

    function updateDaaList(advisories) {
        const container = document.getElementById('daaList');
        if (!container) return;

        if (!advisories || advisories.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 16px;">
                    <div class="empty-state-text text-muted">No active advisories</div>
                </div>
            `;
            return;
        }

        container.innerHTML = advisories.map(advisory => {
            const severityLabel = formatDaaSeverity(advisory.severity);
            const actionLabel = (advisory.action || 'monitor').toUpperCase();
            const sourceLabel = (advisory.source || 'system').toUpperCase();
            const description = advisory.description || 'DAA advisory active';
            return `
                <div class="list-item" style="padding: 8px; margin-bottom: 6px;" onclick="MapControl.selectDrone('${advisory.drone_id}')">
                    <div class="list-item-content">
                        <div class="list-item-title" style="font-size: 12px;">${advisory.drone_id} • ${sourceLabel}</div>
                        <div class="list-item-subtitle" style="font-size: 11px;">${actionLabel} - ${description}</div>
                    </div>
                    <span class="status-badge ${getDaaClass(advisory.severity)}">${severityLabel}</span>
                </div>
            `;
        }).join('');
    }

    function showSelectedDronePanel(show) {
        const panel = document.getElementById('selectedDronePanel');
        if (panel) panel.style.display = show ? 'block' : 'none';
    }

    function updateSelectedDronePanel(data) {
        if (!data) return;

        const isExternal = !!data.external;
        const nameEl = document.getElementById('selectedDroneName');
        const latEl = document.getElementById('selectedDroneLat');
        const lonEl = document.getElementById('selectedDroneLon');
        const altEl = document.getElementById('selectedDroneAlt');
        const speedEl = document.getElementById('selectedDroneSpeed');
        const statusEl = document.getElementById('selectedDroneStatus');
        const conformanceEl = document.getElementById('selectedDroneConformance');
        const conformanceCodeEl = document.getElementById('selectedDroneConformanceCode');
        const conformanceNoteEl = document.getElementById('selectedDroneConformanceNote');
        const holdBtn = document.getElementById('btnHoldDrone');
        const resumeBtn = document.getElementById('btnResumeDrone');

        if (nameEl) {
            nameEl.textContent = selectedDroneId
                ? (isExternal ? `${selectedDroneId} (RID)` : selectedDroneId)
                : '--';
        }
        if (latEl) latEl.textContent = data.lat?.toFixed(6) || '--';
        if (lonEl) lonEl.textContent = data.lon?.toFixed(6) || '--';
        if (altEl) altEl.textContent = data.alt?.toFixed(1) || '--';
        if (speedEl) speedEl.textContent = data.speed?.toFixed(1) || '--';
        if (statusEl) statusEl.className = `status-dot ${getStatusClass(data.status)}`;
        if (isExternal) {
            if (conformanceEl) conformanceEl.textContent = 'external';
            if (conformanceCodeEl) conformanceCodeEl.textContent = '--';
            if (conformanceNoteEl) conformanceNoteEl.textContent = 'Remote ID traffic';
        } else {
            const conformance = conformanceStatuses.get(selectedDroneId);
            if (conformanceEl) {
                conformanceEl.textContent = conformance?.status || 'unknown';
            }
            if (conformanceCodeEl) {
                conformanceCodeEl.textContent = conformance?.record?.conformance_state_code || '--';
            }
            if (conformanceNoteEl) {
                conformanceNoteEl.textContent = conformance?.record?.description || '--';
            }
        }

        if (holdBtn) {
            holdBtn.disabled = isExternal;
            holdBtn.title = isExternal ? 'External traffic (Remote ID)' : '';
        }
        if (resumeBtn) {
            resumeBtn.disabled = isExternal;
            resumeBtn.title = isExternal ? 'External traffic (Remote ID)' : '';
        }

        updateSelectedDaaFields();
    }

    function updateSelectedDaaFields() {
        const severityEl = document.getElementById('selectedDroneDaaSeverity');
        const actionEl = document.getElementById('selectedDroneDaaAction');
        const sourceEl = document.getElementById('selectedDroneDaaSource');
        const noteEl = document.getElementById('selectedDroneDaaNote');

        if (!selectedDroneId) {
            if (severityEl) severityEl.textContent = '--';
            if (actionEl) actionEl.textContent = '--';
            if (sourceEl) sourceEl.textContent = '--';
            if (noteEl) noteEl.textContent = '--';
            return;
        }

        const selectedData = droneData.get(selectedDroneId);
        if (selectedData && selectedData.external) {
            if (severityEl) severityEl.textContent = 'n/a';
            if (actionEl) actionEl.textContent = 'n/a';
            if (sourceEl) sourceEl.textContent = 'n/a';
            if (noteEl) noteEl.textContent = 'External traffic';
            return;
        }

        const advisory = daaByDrone.get(selectedDroneId);
        if (!advisory) {
            if (severityEl) severityEl.textContent = 'clear';
            if (actionEl) actionEl.textContent = '--';
            if (sourceEl) sourceEl.textContent = '--';
            if (noteEl) noteEl.textContent = '--';
            return;
        }

        if (severityEl) severityEl.textContent = formatDaaSeverity(advisory.severity);
        if (actionEl) actionEl.textContent = advisory.action || '--';
        if (sourceEl) sourceEl.textContent = advisory.source || '--';
        if (noteEl) noteEl.textContent = advisory.description || '--';
    }

    function getStatusClass(status) {
        return statusUtils.getStatusClass(status);
    }

    function getConformanceClass(status) {
        switch (status) {
            case 'conforming':
                return 'pass';
            case 'nonconforming':
                return 'fail';
            default:
                return 'warn';
        }
    }

    function normalizeDaaSeverity(severity) {
        return (severity || '').toString().toLowerCase();
    }

    function getDaaSeverityRank(severity) {
        switch (normalizeDaaSeverity(severity)) {
            case 'critical':
                return 3;
            case 'warning':
                return 2;
            case 'advisory':
                return 1;
            default:
                return 0;
        }
    }

    function getDaaClass(severity) {
        switch (normalizeDaaSeverity(severity)) {
            case 'critical':
                return 'fail';
            case 'warning':
                return 'warn';
            case 'advisory':
                return 'pending';
            default:
                return 'warn';
        }
    }

    function formatDaaSeverity(severity) {
        const normalized = normalizeDaaSeverity(severity);
        return normalized ? normalized.toUpperCase() : 'UNKNOWN';
    }

    // ========================================================================
    // Camera Controls
    // ========================================================================

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function normalizeHeading(value) {
        const twoPi = Math.PI * 2;
        let heading = value % twoPi;
        if (heading < 0) heading += twoPi;
        return heading;
    }

    function setOrbitAxisVisible(isVisible) {
        const axis = document.getElementById('orbitAxis');
        if (!axis) return;
        axis.classList.toggle('active', isVisible);
    }

    function syncOrbitCamera(clockTime) {
        if (!viewer || cameraMode !== 'orbit' || !trackedDroneId) return;
        const entity = droneEntities.get(trackedDroneId);
        if (!entity || !entity.position) return;

        const time = clockTime || viewer.clock.currentTime;
        const position = entity.position.getValue(time);
        if (!position) return;

        const offset = new Cesium.HeadingPitchRange(orbitHeading, orbitPitch, orbitRange);
        viewer.camera.lookAt(position, offset);
    }

    function resetOrbit() {
        orbitHeading = 0;
        orbitPitch = Cesium.Math.toRadians(-35);
        orbitRange = 600;
        syncOrbitCamera();
    }

    function nudgeOrbit(action) {
        switch (action) {
            case 'left':
                orbitHeading = normalizeHeading(orbitHeading - ORBIT_STEP_HEADING);
                break;
            case 'right':
                orbitHeading = normalizeHeading(orbitHeading + ORBIT_STEP_HEADING);
                break;
            case 'up':
                orbitPitch = clamp(orbitPitch + ORBIT_STEP_PITCH, ORBIT_PITCH_MIN, ORBIT_PITCH_MAX);
                break;
            case 'down':
                orbitPitch = clamp(orbitPitch - ORBIT_STEP_PITCH, ORBIT_PITCH_MIN, ORBIT_PITCH_MAX);
                break;
            case 'zoom-in':
                orbitRange = clamp(orbitRange - ORBIT_STEP_RANGE, ORBIT_RANGE_MIN, ORBIT_RANGE_MAX);
                break;
            case 'zoom-out':
                orbitRange = clamp(orbitRange + ORBIT_STEP_RANGE, ORBIT_RANGE_MIN, ORBIT_RANGE_MAX);
                break;
            case 'reset':
                resetOrbit();
                return;
            default:
                return;
        }
        syncOrbitCamera();
    }

    function setCameraMode(mode) {
        cameraMode = mode;
        console.log('[Map] Camera mode:', mode);

        if (!viewer) {
            setOrbitAxisVisible(mode === 'orbit');
            return;
        }

        if (mode === 'free') {
            viewer.trackedEntity = undefined;
            viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            setOrbitAxisVisible(false);
        } else if (mode === 'orbit') {
            viewer.trackedEntity = undefined;
            setOrbitAxisVisible(true);
            syncOrbitCamera();
        } else if (mode === 'cockpit') {
            viewer.trackedEntity = undefined;
            viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            setOrbitAxisVisible(false);
        }

        // Update button styles
        ['free', 'orbit', 'cockpit'].forEach(m => {
            const btn = document.getElementById(`cam-${m}-btn`);
            if (btn) {
                if (m === mode) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
        });
    }

    function setTimeOfDay(mode) {
        currentTOD = mode;
        console.log('[Map] Time of day:', mode);

        if (mode === 'realtime') {
            viewer.clock.currentTime = Cesium.JulianDate.now();
            viewer.clock.shouldAnimate = true;
            viewer.clock.multiplier = 1;
        } else if (mode === 'day') {
            const noon = new Date();
            noon.setUTCHours(12, 0, 0, 0);
            viewer.clock.currentTime = Cesium.JulianDate.fromDate(noon);
            viewer.clock.shouldAnimate = false;
        } else if (mode === 'night') {
            const midnight = new Date();
            midnight.setUTCHours(0, 0, 0, 0);
            viewer.clock.currentTime = Cesium.JulianDate.fromDate(midnight);
            viewer.clock.shouldAnimate = false;
        }
    }

    // ========================================================================
    // Drone Selection & Commands
    // ========================================================================

    function selectDrone(droneId) {
        selectedDroneId = droneId;
        trackedDroneId = droneId;

        const entity = droneEntities.get(droneId);
        if (entity) {
            viewer.selectedEntity = entity;

            if (cameraMode === 'orbit') {
                syncOrbitCamera();
            } else if (cameraMode !== 'cockpit') {
                viewer.flyTo(entity, {
                    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 500)
                });
            }
        }

        showSelectedDronePanel(true);
        const data = droneData.get(droneId);
        if (data) updateSelectedDronePanel(data);
    }

    async function holdDrone() {
        if (!selectedDroneId) return;
        const data = droneData.get(selectedDroneId);
        if (data && data.external) {
            console.warn('[Map] HOLD disabled for external traffic');
            return;
        }

        try {
            await API.holdDrone(selectedDroneId, 30);
            console.log(`[Map] HOLD sent to ${selectedDroneId}`);
        } catch (e) {
            console.error('[Map] Hold command failed:', e);
        }
    }

    async function resumeDrone() {
        if (!selectedDroneId) return;
        const data = droneData.get(selectedDroneId);
        if (data && data.external) {
            console.warn('[Map] RESUME disabled for external traffic');
            return;
        }

        try {
            await API.resumeDrone(selectedDroneId);
            console.log(`[Map] RESUME sent to ${selectedDroneId}`);
        } catch (e) {
            console.error('[Map] Resume command failed:', e);
        }
    }

    // ========================================================================
    // Initialize on DOM Ready
    // ========================================================================

    document.addEventListener('DOMContentLoaded', () => {
        initViewer();

        // Command buttons
        const holdBtn = document.getElementById('btnHoldDrone');
        const resumeBtn = document.getElementById('btnResumeDrone');

        if (holdBtn) holdBtn.addEventListener('click', holdDrone);
        if (resumeBtn) resumeBtn.addEventListener('click', resumeDrone);
    });

    // ========================================================================
    // Public API
    // ========================================================================

    window.MapControl = {
        selectDrone,
        holdDrone,
        resumeDrone,
        setCameraMode,
        setTimeOfDay,
        nudgeOrbit,
        resetOrbit,
        getViewer: () => viewer
    };

})();
