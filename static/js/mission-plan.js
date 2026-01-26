/**
 * Mission Planner
 * Creates flight declarations via Flight Blender from waypoint-based routes.
 */

(function () {
    'use strict';

    const CesiumConfig = window.__CESIUM_CONFIG__ || {};

    const CONFIG = {
        CESIUM_ION_TOKEN: CesiumConfig.ionToken || '',
        GOOGLE_3D_TILES_ASSET_ID: Number(CesiumConfig.google3dTilesAssetId) || 0,
        DEFAULT_VIEW: { lat: 33.6846, lon: -117.8265, height: 2500 }
    };

    function toNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    const COMPLIANCE_REFRESH_MS = 400;
    const statusUtils = window.ATCStatus || {
        getStatusLabel: (status) => status || 'Unknown'
    };
    const utils = window.ATCUtils;
    const escapeHtml = window.escapeHtml || ((value) => String(value ?? ''));

    const state = {
        viewer: null,
        waypoints: [],
        waypointEntities: [],
        routeEntity: null,
        optimizedRoute: [],
        routeResult: null,
        routeCalculationInFlight: false,
        hazardEntities: [],
        dynamicHazards: [],
        geofences: [],
        geofenceEntities: new Map(),
        compliance: null,
        complianceTimer: null,
        analysisInFlight: false,
        prefillDroneId: null
    };

    async function init() {
        initFormDefaults();
        await initViewer();
        await initRoutePlanner();
        bindUi();
        bindCompliance();
        await loadDrones();
        await loadGeofences();
        const prefilled = applyPlannerPrefill();
        if (!prefilled) {
            setRouteStatus('Route not analyzed yet.');
        }
        updateCompliance();
    }

    function initFormDefaults() {
        const startInput = document.getElementById('missionStart');
        const endInput = document.getElementById('missionEnd');
        const now = new Date();
        const start = new Date(now.getTime() + 5 * 60 * 1000);
        const end = new Date(now.getTime() + 45 * 60 * 1000);

        if (startInput) startInput.value = toLocalInputValue(start);
        if (endInput) endInput.value = toLocalInputValue(end);
        applyPopulationPreset(true);
    }

    function toLocalInputValue(date) {
        const offset = date.getTimezoneOffset() * 60000;
        return new Date(date.getTime() - offset).toISOString().slice(0, 16);
    }

    function generateFlightId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return `plan-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    }

    async function loadDrones() {
        const select = document.getElementById('droneSelect');
        if (!select) return;

        try {
            const ownerId = window.APP_USER?.role !== 'authority' ? window.APP_USER?.id : null;
            const drones = await API.getDrones(ownerId);
            drones.forEach((drone) => {
                const statusLabel = statusUtils.getStatusLabel(drone.status);
                const option = document.createElement('option');
                option.value = drone.drone_id;
                option.textContent = `${drone.drone_id} (${statusLabel})`;
                select.appendChild(option);
            });

            if (state.prefillDroneId) {
                const match = Array.from(select.options).find((opt) => opt.value === state.prefillDroneId);
                if (match) {
                    select.value = state.prefillDroneId;
                    state.prefillDroneId = null;
                }
            }
        } catch (error) {
            console.error('[MissionPlan] Failed to load drones:', error);
        }
    }

    function applyPlannerPrefill() {
        let raw = null;
        try {
            raw = sessionStorage.getItem('plannerPrefill');
        } catch (error) {
            raw = null;
        }

        if (!raw) return false;

        let data = null;
        try {
            data = JSON.parse(raw);
        } catch (error) {
            data = null;
        }

        try {
            sessionStorage.removeItem('plannerPrefill');
        } catch (error) {
            // ignore
        }

        if (!data || !Array.isArray(data.waypoints) || data.waypoints.length === 0) {
            return false;
        }

        const normalized = data.waypoints.map((wp) => ({
            lat: Number(wp.lat),
            lon: Number(wp.lon),
            alt: Number(wp.alt)
        })).filter((wp) => Number.isFinite(wp.lat) && Number.isFinite(wp.lon));

        if (!normalized.length) return false;

        state.waypoints = normalized.map((wp) => ({ lat: wp.lat, lon: wp.lon, alt: wp.alt }));
        state.optimizedRoute = normalized.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: wp.alt,
            phase: 'CRUISE',
            prio: 1
        }));
        state.routeResult = { optimized: true, validation: { isValid: true } };

        if (data.missionName) setInputValue('missionName', data.missionName);
        if (data.missionType) setInputValue('missionType', data.missionType);
        if (Number.isFinite(Number(data.operationType))) {
            setInputValue('operationType', Number(data.operationType));
        }

        if (data.missionStart) {
            const start = new Date(data.missionStart);
            if (!Number.isNaN(start.getTime())) {
                setInputValue('missionStart', toLocalInputValue(start));
            }
        }
        if (data.missionEnd) {
            const end = new Date(data.missionEnd);
            if (!Number.isNaN(end.getTime())) {
                setInputValue('missionEnd', toLocalInputValue(end));
            }
        }

        if (Number.isFinite(Number(data.minAltitude))) {
            setInputValue('minAltitude', Number(data.minAltitude).toFixed(0));
        }
        if (Number.isFinite(Number(data.maxAltitude))) {
            setInputValue('maxAltitude', Number(data.maxAltitude).toFixed(0));
        }
        if (Number.isFinite(Number(data.cruiseSpeedMps))) {
            setInputValue('cruiseSpeed', Number(data.cruiseSpeedMps));
        }
        if (Number.isFinite(Number(data.batteryCapacityMin))) {
            setInputValue('batteryCapacity', Number(data.batteryCapacityMin));
        }
        if (Number.isFinite(Number(data.batteryReserveMin))) {
            setInputValue('batteryReserve', Number(data.batteryReserveMin));
        }

        if (data.weather) {
            setInputValue('weatherWind', data.weather.windMps);
            setInputValue('weatherGust', data.weather.gustMps);
            setInputValue('weatherPrecip', data.weather.precipMm);
        }

        if (Number.isFinite(Number(data.populationDensity))) {
            setInputValue('populationDensity', Number(data.populationDensity).toFixed(0));
        }
        if (Number.isFinite(Number(data.obstacleClearanceM))) {
            setInputValue('obstacleClearance', Number(data.obstacleClearanceM));
        }

        if (data.droneId) {
            const select = document.getElementById('droneSelect');
            if (select) {
                const match = Array.from(select.options).find((opt) => opt.value === data.droneId);
                if (match) {
                    select.value = data.droneId;
                } else {
                    state.prefillDroneId = data.droneId;
                }
            } else {
                state.prefillDroneId = data.droneId;
            }
        }

        renderWaypoints();
        updateRouteVisualization();
        setRouteStatus('Planner route imported. Review compliance and submit.');
        runComplianceAnalysis();

        return true;
    }

    async function loadGeofences() {
        try {
            const geofences = await API.getGeofences();
            state.geofences = (geofences || []).filter((geofence) => geofence.active);
            renderGeofences();
            updateCompliance();
        } catch (error) {
            console.error('[MissionPlan] Failed to load geofences:', error);
            state.geofences = [];
        }
    }

    async function initViewer() {
        Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;

        const terrainProvider = await Cesium.createWorldTerrainAsync();

        state.viewer = new Cesium.Viewer('missionMap', {
            terrainProvider,
            globe: new Cesium.Globe(Cesium.Ellipsoid.WGS84),
            skyAtmosphere: new Cesium.SkyAtmosphere(),
            geocoder: false,
            homeButton: false,
            baseLayerPicker: false,
            infoBox: false,
            sceneModePicker: false,
            animation: false,
            selectionIndicator: false,
            fullscreenButton: false,
            timeline: false,
            navigationHelpButton: false,
            shadows: false
        });

        state.viewer.scene.globe.enableLighting = true;
        state.viewer.scene.globe.depthTestAgainstTerrain = true;

        try {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.GOOGLE_3D_TILES_ASSET_ID);
            state.viewer.scene.primitives.add(tileset);
        } catch (error) {
            const esriImagery = new Cesium.UrlTemplateImageryProvider({
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                credit: 'Esri'
            });
            state.viewer.imageryLayers.addImageryProvider(esriImagery);
        }

	        state.viewer.camera.setView({
	            destination: Cesium.Cartesian3.fromDegrees(CONFIG.DEFAULT_VIEW.lon, CONFIG.DEFAULT_VIEW.lat, CONFIG.DEFAULT_VIEW.height),
	            orientation: {
	                heading: Cesium.Math.toRadians(0),
	                pitch: Cesium.Math.toRadians(-40),
	                roll: 0
	            }
	        });

	        if (window.ATCCameraControls && typeof window.ATCCameraControls.attach === 'function') {
	            window.ATCCameraControls.attach(state.viewer);
	        }

	        const handler = new Cesium.ScreenSpaceEventHandler(state.viewer.scene.canvas);
	        handler.setInputAction((movement) => {
	            const cartesian = pickPosition(movement.position);
	            if (!cartesian) return;
            const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
            const lat = Cesium.Math.toDegrees(cartographic.latitude);
            const lon = Cesium.Math.toDegrees(cartographic.longitude);
            addWaypoint({ lat, lon });
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        renderGeofences();
        renderHazards();
    }

    async function initRoutePlanner() {
        if (!state.viewer || !window.RoutePlanner) return;
        try {
            await window.RoutePlanner.init(state.viewer, {
                defaultAltitudeM: getPlannerAltitude(),
                loadBuildings: true
            });
        } catch (error) {
            console.warn('[MissionPlan] Route planner init failed:', error);
        }
    }

    function pickPosition(position) {
        if (state.viewer.scene.pickPositionSupported) {
            const pick = state.viewer.scene.pickPosition(position);
            if (pick) return pick;
        }
        return state.viewer.camera.pickEllipsoid(position, state.viewer.scene.globe.ellipsoid);
    }

    function bindUi() {
        const removeLastBtn = document.getElementById('removeLastWaypoint');
        const clearBtn = document.getElementById('clearWaypoints');
        const optimizeBtn = document.getElementById('optimizeRoute');
        const submitBtn = document.getElementById('submitMission');

        if (removeLastBtn) {
            removeLastBtn.addEventListener('click', () => {
                state.waypoints.pop();
                clearOptimizedRoute();
                renderWaypoints();
                updateRouteVisualization();
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                state.waypoints = [];
                clearOptimizedRoute();
                renderWaypoints();
                updateRouteVisualization();
            });
        }

        if (optimizeBtn) {
            optimizeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                computeOptimizedRoute();
            });
        }

        if (submitBtn) {
            submitBtn.addEventListener('click', submitMission);
        }
    }

    function bindCompliance() {
        const fetchBtn = document.getElementById('fetchWeather');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', (event) => {
                event.preventDefault();
                fetchWeather();
            });
        }

        const analyzeBtn = document.getElementById('analyzeCompliance');
        if (analyzeBtn) {
            analyzeBtn.addEventListener('click', (event) => {
                event.preventDefault();
                runComplianceAnalysis();
            });
        }

        const autoBatteryBtn = document.getElementById('autoBattery');
        if (autoBatteryBtn) {
            autoBatteryBtn.addEventListener('click', (event) => {
                event.preventDefault();
                applyAutoBattery();
            });
        }

        const inputIds = [
            'batteryCapacity',
            'batteryReserve',
            'cruiseSpeed',
            'obstacleClearance',
            'complianceOverride',
            'complianceNotes',
            'operationType',
            'minAltitude',
            'maxAltitude'
        ];

        inputIds.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
            el.addEventListener(eventName, () => {
                if (id === 'minAltitude' || id === 'maxAltitude') {
                    clearOptimizedRoute();
                    updateRouteVisualization();
                }
                updateCompliance();
            });
        });

        lockComplianceInputs();
    }

    function lockComplianceInputs() {
        const readonlyIds = [
            'weatherWind',
            'weatherGust',
            'weatherPrecip',
            'weatherMaxWind',
            'weatherMaxGust',
            'weatherMaxPrecip',
            'populationDensity'
        ];
        readonlyIds.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.readOnly = true;
        });

        const populationClass = document.getElementById('populationClass');
        if (populationClass) {
            populationClass.disabled = true;
        }
    }

    function addWaypoint({ lat, lon }) {
        state.waypoints.push({ lat, lon });
        clearOptimizedRoute();
        renderWaypoints();
        updateRouteVisualization();
    }

    function getPlannerAltitude() {
        const maxAltitude = getNumberValue('maxAltitude', 0);
        const minAltitude = getNumberValue('minAltitude', 0);
        if (Number.isFinite(maxAltitude) && maxAltitude > 0) return maxAltitude;
        if (Number.isFinite(minAltitude) && minAltitude > 0) return minAltitude;
        return 60;
    }

    function getActiveRoute() {
        if (state.optimizedRoute && state.optimizedRoute.length) {
            return state.optimizedRoute;
        }
        return state.waypoints;
    }

    function clearOptimizedRoute() {
        state.optimizedRoute = [];
        state.routeResult = null;
        setRouteStatus('Route not analyzed yet.');
    }

    function setRouteStatus(message) {
        const el = document.getElementById('routeStatus');
        if (el) {
            el.textContent = message;
        }
    }

    async function computeOptimizedRoute() {
        if (state.routeCalculationInFlight) return;
        if (!state.viewer || !window.RoutePlanner) {
            showMessage('error', 'Route planner is not available yet.');
            return;
        }
        if (state.waypoints.length < 2) {
            showMessage('error', 'Add at least two waypoints to optimize.');
            return;
        }

        const plannedAltitude = getPlannerAltitude();
        const plannerWaypoints = state.waypoints.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: plannedAltitude
        }));

        state.routeCalculationInFlight = true;
        setRouteStatus('Analyzing buildings and optimizing route...');

        try {
            const result = await window.RoutePlanner.calculateRoute(plannerWaypoints, {
                plannedAltitude,
                defaultAltitudeM: plannedAltitude,
                geofences: state.geofences
            });
            state.routeResult = result;
            state.optimizedRoute = Array.isArray(result?.waypoints) ? result.waypoints : [];

            if (result.optimized) {
                setRouteStatus('Optimized route ready.');
            } else if (result.validation?.isValid) {
                setRouteStatus('Straight route is clear.');
            } else {
                setRouteStatus('Route blocked; adjust waypoints or altitude.');
            }

            updateRouteVisualization();
            updateCompliance();
            syncAltitudeInputs(result);
        } catch (error) {
            console.error('[MissionPlan] Route optimization failed:', error);
            setRouteStatus('Route optimization failed.');
            showMessage('error', error.message || 'Route optimization failed.');
        } finally {
            state.routeCalculationInFlight = false;
        }
    }

    function syncAltitudeInputs(result) {
        if (!result || !Array.isArray(result.waypoints) || !result.waypoints.length) return;
        const minAltInput = document.getElementById('minAltitude');
        const maxAltInput = document.getElementById('maxAltitude');
        if (!minAltInput || !maxAltInput) return;

        const altitudes = result.waypoints
            .map((wp) => Number(wp.alt))
            .filter((alt) => Number.isFinite(alt));
        if (!altitudes.length) return;

        const minAlt = Math.min(...altitudes);
        const maxAlt = Math.max(...altitudes);

        if (!Number.isFinite(Number(minAltInput.value)) || Number(minAltInput.value) <= 0) {
            minAltInput.value = Math.round(minAlt);
        }
        if (!Number.isFinite(Number(maxAltInput.value)) || Number(maxAltInput.value) <= 0) {
            maxAltInput.value = Math.round(maxAlt);
        }
    }

    function applyPopulationPreset(force) {
        const select = document.getElementById('populationClass');
        const densityInput = document.getElementById('populationDensity');
        if (!select || !densityInput) return;

        const presets = {
            rural: 100,
            suburban: 1000,
            urban: 2500,
            dense: 4000
        };

        if (force || document.activeElement !== densityInput) {
            const preset = presets[select.value];
            if (Number.isFinite(preset)) {
                densityInput.value = preset;
            }
        }
    }

    function classifyPopulation(density) {
        if (!Number.isFinite(density)) return 'suburban';
        if (density < 200) return 'rural';
        if (density < 1000) return 'suburban';
        if (density < 2500) return 'urban';
        return 'dense';
    }

    function renderWaypoints() {
        const list = document.getElementById('waypointList');
        if (!list) return;

        if (state.waypoints.length === 0) {
            list.innerHTML = `
                <div class="empty-state" style="padding: 12px;">
                    <div class="empty-state-text text-muted">No waypoints yet</div>
                </div>
            `;
            return;
        }

        list.innerHTML = state.waypoints.map((wp, index) => `
            <div class="waypoint-item">
                <span>#${escapeHtml(index + 1)} ${escapeHtml(wp.lat.toFixed(5))}, ${escapeHtml(wp.lon.toFixed(5))}</span>
                <button class="btn btn-ghost btn-sm" data-index="${escapeHtml(index)}">Remove</button>
            </div>
        `).join('');

        list.querySelectorAll('button[data-index]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-index'));
                state.waypoints.splice(idx, 1);
                renderWaypoints();
                updateRouteVisualization();
            });
        });
    }

    function updateRouteVisualization() {
        if (!state.viewer) return;

        state.waypointEntities.forEach((entity) => state.viewer.entities.remove(entity));
        state.waypointEntities = [];

        if (state.routeEntity) {
            state.viewer.entities.remove(state.routeEntity);
            state.routeEntity = null;
        }

        if (state.waypoints.length === 0) {
            updateCompliance();
            return;
        }

        const activeRoute = getActiveRoute();
        const positions = activeRoute.map((wp) =>
            Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, Number.isFinite(wp.alt) ? wp.alt : 0)
        );

        state.waypointEntities = state.waypoints.map((wp, index) => state.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, 0),
            point: {
                pixelSize: 10,
                color: Cesium.Color.fromCssColorString('#38bdf8'),
                outlineColor: Cesium.Color.fromCssColorString('#0f172a'),
                outlineWidth: 2
            },
            label: {
                text: `WP ${index + 1}`,
                font: '12px sans-serif',
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                outlineWidth: 2,
                fillColor: Cesium.Color.WHITE,
                pixelOffset: new Cesium.Cartesian2(0, -18)
            }
        }));

        if (positions.length > 1) {
            const routeColor = state.routeResult?.optimized
                ? Cesium.Color.fromCssColorString('#22c55e')
                : Cesium.Color.fromCssColorString('#f59e0b');
            state.routeEntity = state.viewer.entities.add({
                polyline: {
                    positions,
                    width: 3,
                    material: routeColor
                }
            });
        }

        updateCompliance();
    }

    function renderGeofences() {
        if (!state.viewer) return;
        clearGeofences();

        state.geofences.forEach((geofence) => {
            const positions = geofence.polygon.map(([lat, lon]) =>
                Cesium.Cartesian3.fromDegrees(lon, lat, geofence.lower_altitude_m || 0)
            );
            const colors = getGeofenceColors(geofence.geofence_type);
            const entity = state.viewer.entities.add({
                id: `mission-geofence-${geofence.id}`,
                name: geofence.name,
                polygon: {
                    hierarchy: positions,
                    height: geofence.lower_altitude_m || 0,
                    extrudedHeight: geofence.upper_altitude_m || 0,
                    material: colors.fill,
                    outline: true,
                    outlineColor: colors.outline,
                    outlineWidth: 2
                }
            });

            state.geofenceEntities.set(geofence.id, entity);
        });
    }

    function clearGeofences() {
        state.geofenceEntities.forEach((entity) => state.viewer.entities.remove(entity));
        state.geofenceEntities.clear();
    }

    function getGeofenceColors(type) {
        switch (type) {
            case 'no_fly_zone':
                return {
                    fill: Cesium.Color.RED.withAlpha(0.2),
                    outline: Cesium.Color.RED
                };
            case 'restricted_area':
                return {
                    fill: Cesium.Color.YELLOW.withAlpha(0.2),
                    outline: Cesium.Color.YELLOW
                };
            case 'temporary_restriction':
                return {
                    fill: Cesium.Color.ORANGE.withAlpha(0.2),
                    outline: Cesium.Color.ORANGE
                };
            default:
                return {
                    fill: Cesium.Color.BLUE.withAlpha(0.15),
                    outline: Cesium.Color.BLUE
                };
        }
    }

    function renderHazards() {
        if (!state.viewer) return;
        clearHazards();

        const hazards = state.dynamicHazards;

        state.hazardEntities = hazards.flatMap((hazard) => {
            const position = Cesium.Cartesian3.fromDegrees(hazard.lon, hazard.lat, 0);
            const marker = state.viewer.entities.add({
                position,
                point: {
                    pixelSize: 10,
                    color: Cesium.Color.fromCssColorString('#f97316'),
                    outlineColor: Cesium.Color.fromCssColorString('#0f172a'),
                    outlineWidth: 2
                },
                label: {
                    text: hazard.name,
                    font: '12px sans-serif',
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    outlineWidth: 2,
                    fillColor: Cesium.Color.WHITE,
                    pixelOffset: new Cesium.Cartesian2(0, -18)
                }
            });

            const zone = state.viewer.entities.add({
                position,
                ellipse: {
                    semiMinorAxis: hazard.radiusM || 60,
                    semiMajorAxis: hazard.radiusM || 60,
                    material: Cesium.Color.fromCssColorString('rgba(248, 113, 113, 0.15)'),
                    outline: true,
                    outlineColor: Cesium.Color.fromCssColorString('#ef4444'),
                    height: 0
                }
            });

            return [marker, zone];
        });
    }

    function clearHazards() {
        state.hazardEntities.forEach((entity) => state.viewer.entities.remove(entity));
        state.hazardEntities = [];
    }

    function getComplianceOverride() {
        return {
            enabled: !!document.getElementById('complianceOverride')?.checked,
            notes: (document.getElementById('complianceNotes')?.value || '').trim()
        };
    }

    function buildComplianceRequest(activeRoute) {
        const droneId = document.getElementById('droneSelect')?.value || null;
        const cruiseSpeed = getNumberValue('cruiseSpeed', 0);
        const batteryCapacity = getNumberValue('batteryCapacity', 0);
        const batteryReserve = getNumberValue('batteryReserve', 0);
        const clearance = getNumberValue('obstacleClearance', 60);
        const operationType = Number(document.getElementById('operationType')?.value || 1);
        const override = getComplianceOverride();

        const fallbackAlt = getPlannerAltitude();
        const waypoints = activeRoute.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            altitude_m: Number.isFinite(wp.alt) ? wp.alt : fallbackAlt
        }));

        const metadata = {
            drone_speed_mps: cruiseSpeed > 0 ? cruiseSpeed : undefined,
            battery_capacity_min: Number.isFinite(batteryCapacity) && batteryCapacity > 0 ? batteryCapacity : undefined,
            battery_reserve_min: Number.isFinite(batteryReserve) ? batteryReserve : undefined,
            clearance_m: Number.isFinite(clearance) ? clearance : undefined,
            operation_type: operationType,
            compliance_override_enabled: override.enabled,
            compliance_override_notes: override.notes || undefined
        };

        const payload = { waypoints, metadata };
        if (droneId) payload.drone_id = droneId;

        return { payload, override };
    }

    function mapConflictList(conflicts) {
        if (!Array.isArray(conflicts)) return [];
        return conflicts.map((conflict) => ({
            id: conflict.id,
            name: conflict.name,
            distanceM: toNumber(conflict.distance_m) ?? toNumber(conflict.distanceM),
            severity: conflict.severity || 'conflict'
        }));
    }

    function mapHazardList(hazards) {
        if (!Array.isArray(hazards)) return [];
        return hazards
            .map((hazard) => ({
                id: hazard.id,
                name: hazard.name,
                lat: toNumber(hazard.lat),
                lon: toNumber(hazard.lon),
                radiusM: toNumber(hazard.radius_m) ?? toNumber(hazard.radiusM),
                heightM: toNumber(hazard.height_m) ?? toNumber(hazard.heightM),
                hazardType: hazard.hazard_type || hazard.hazardType || 'unknown',
                source: hazard.source || null,
                distanceM: toNumber(hazard.distance_m) ?? toNumber(hazard.distanceM)
            }))
            .filter((hazard) => Number.isFinite(hazard.lat) && Number.isFinite(hazard.lon));
    }

    function buildPendingComplianceSnapshot(override, result) {
        return {
            generated_at: new Date().toISOString(),
            overall_status: 'pending',
            route: { distanceM: 0, estimatedMinutes: 0, hasRoute: false },
            checks: {
                weather: { status: 'pending', message: 'Awaiting analysis.' },
                battery: { status: 'pending', message: 'Awaiting analysis.' },
                population: { status: 'pending', message: 'Awaiting analysis.' },
                obstacles: { status: 'pending', message: 'Awaiting analysis.', conflicts: [], hazards: [] }
            },
            override,
            blocking: Array.isArray(result?.blocking) ? result.blocking : [],
            violations: Array.isArray(result?.violations) ? result.violations : [],
            ok: false
        };
    }

    function normalizeComplianceResponse(result, override) {
        const report = result?.report;
        if (!report) {
            return buildPendingComplianceSnapshot(override, result);
        }

        const route = report.route || {};
        const checks = report.checks || {};
        const weather = checks.weather || {};
        const battery = checks.battery || {};
        const population = checks.population || {};
        const obstacles = checks.obstacles || {};

        return {
            generated_at: report.generated_at,
            overall_status: report.overall_status,
            route: {
                distanceM: toNumber(route.distance_m) ?? 0,
                estimatedMinutes: toNumber(route.estimated_minutes) ?? 0,
                hasRoute: !!route.has_route
            },
            checks: {
                weather: {
                    status: weather.status || 'pending',
                    message: weather.message || '',
                    windMps: toNumber(weather.wind_mps),
                    gustMps: toNumber(weather.gust_mps),
                    precipMm: toNumber(weather.precip_mm),
                    maxWindMps: toNumber(weather.max_wind_mps),
                    maxGustMps: toNumber(weather.max_gust_mps),
                    maxPrecipMm: toNumber(weather.max_precip_mm),
                    source: weather.source || null
                },
                battery: {
                    status: battery.status || 'pending',
                    message: battery.message || '',
                    estimatedMinutes: toNumber(battery.estimated_minutes),
                    capacityMin: toNumber(battery.capacity_min),
                    reserveMin: toNumber(battery.reserve_min),
                    remainingMin: toNumber(battery.remaining_min),
                    cruiseSpeedMps: toNumber(battery.cruise_speed_mps)
                },
                population: {
                    status: population.status || 'pending',
                    message: population.message || '',
                    density: toNumber(population.density),
                    classification: population.classification || null,
                    buildingCount: toNumber(population.building_count),
                    estimatedPopulation: toNumber(population.estimated_population),
                    areaKm2: toNumber(population.area_km2),
                    source: population.source || null
                },
                obstacles: {
                    status: obstacles.status || 'pending',
                    message: obstacles.message || '',
                    clearanceM: toNumber(obstacles.clearance_m),
                    conflicts: mapConflictList(obstacles.conflicts),
                    hazards: mapHazardList(obstacles.hazards),
                    obstacleCount: toNumber(obstacles.obstacle_count) ?? 0,
                    truncated: !!obstacles.truncated
                }
            },
            override,
            blocking: Array.isArray(result?.blocking) ? result.blocking : [],
            violations: Array.isArray(result?.violations) ? result.violations : [],
            ok: !!result?.ok
        };
    }

    function applyComplianceInputs(snapshot) {
        if (!snapshot || !snapshot.checks) return;
        const weather = snapshot.checks.weather || {};
        setInputValue('weatherWind', weather.windMps);
        setInputValue('weatherGust', weather.gustMps);
        setInputValue('weatherPrecip', weather.precipMm);
        if (weather.source) setInputValue('weatherSource', weather.source);
        setInputValue('weatherMaxWind', weather.maxWindMps);
        setInputValue('weatherMaxGust', weather.maxGustMps);
        setInputValue('weatherMaxPrecip', weather.maxPrecipMm);

        const population = snapshot.checks.population || {};
        if (Number.isFinite(population.density)) {
            setInputValue('populationDensity', Math.round(population.density));
        }
        const classSelect = document.getElementById('populationClass');
        if (classSelect && population.classification) {
            classSelect.value = population.classification;
        }
    }

    async function runComplianceAnalysis() {
        if (state.analysisInFlight) return state.compliance;
        const activeRoute = getActiveRoute();
        if (!activeRoute.length) {
            const populationMeta = document.getElementById('populationMeta');
            const obstacleMeta = document.getElementById('obstacleMeta');
            if (populationMeta) populationMeta.textContent = 'Add at least one waypoint to analyze.';
            if (obstacleMeta) obstacleMeta.textContent = 'Add at least one waypoint to analyze.';
            const snapshot = buildPendingComplianceSnapshot(getComplianceOverride(), null);
            state.compliance = snapshot;
            renderCompliance(snapshot);
            return snapshot;
        }

        const populationMeta = document.getElementById('populationMeta');
        const obstacleMeta = document.getElementById('obstacleMeta');
        if (populationMeta) populationMeta.textContent = 'Analyzing population density...';
        if (obstacleMeta) obstacleMeta.textContent = 'Scanning obstacles near route...';

        const { payload, override } = buildComplianceRequest(activeRoute);

        state.analysisInFlight = true;
        try {
            const result = await API.evaluateCompliance(payload);
            const snapshot = normalizeComplianceResponse(result, override);
            state.compliance = snapshot;
            state.dynamicHazards = snapshot.checks?.obstacles?.hazards || [];
            renderHazards();
            applyComplianceInputs(snapshot);
            renderCompliance(snapshot);
            return snapshot;
        } catch (error) {
            if (populationMeta) populationMeta.textContent = `Analysis failed: ${error.message}`;
            if (obstacleMeta) obstacleMeta.textContent = 'Obstacle scan failed.';
            return state.compliance;
        } finally {
            state.analysisInFlight = false;
        }
    }

    function applyAutoBattery() {
        const cruiseSpeed = getNumberValue('cruiseSpeed', 0);
        const route = computeRouteMetrics(getActiveRoute(), cruiseSpeed);
        if (!route.hasRoute || cruiseSpeed <= 0) {
            const batteryMeta = document.getElementById('batteryMeta');
            if (batteryMeta) batteryMeta.textContent = 'Set a cruise speed and route before auto estimating.';
            return;
        }

        const estimatedMinutes = route.estimatedMinutes;
        const reserve = Math.max(5, Math.ceil(estimatedMinutes * 0.2));
        const capacity = Math.ceil(estimatedMinutes + reserve + 2);

        setInputValue('batteryReserve', reserve);
        setInputValue('batteryCapacity', Math.max(capacity, getNumberValue('batteryCapacity', 0) || 0));
        updateCompliance();
    }

    function queueComplianceRefresh() {
        if (state.analysisInFlight) return;
        if (state.complianceTimer) {
            clearTimeout(state.complianceTimer);
        }
        state.complianceTimer = setTimeout(() => {
            state.complianceTimer = null;
            runComplianceAnalysis();
        }, COMPLIANCE_REFRESH_MS);
    }

    function updateCompliance() {
        queueComplianceRefresh();
        if (state.compliance) {
            renderCompliance(state.compliance);
        }
        return state.compliance;
    }

    function renderCompliance(snapshot) {
        setStatusBadge(document.getElementById('complianceOverall'), snapshot.overall_status);

        const routeDistance = document.getElementById('routeDistance');
        const routeDuration = document.getElementById('routeDuration');
        if (routeDistance) {
            routeDistance.textContent = snapshot.route.distanceM > 0
                ? formatDistance(snapshot.route.distanceM)
                : '--';
        }
        if (routeDuration) {
            routeDuration.textContent = snapshot.route.estimatedMinutes > 0
                ? formatMinutes(snapshot.route.estimatedMinutes)
                : '--';
        }

        setStatusBadge(document.getElementById('weatherStatus'), snapshot.checks.weather.status);
        setStatusBadge(document.getElementById('batteryStatus'), snapshot.checks.battery.status);
        setStatusBadge(document.getElementById('populationStatus'), snapshot.checks.population.status);
        setStatusBadge(document.getElementById('obstacleStatus'), snapshot.checks.obstacles.status);

        const weatherMeta = document.getElementById('weatherMeta');
        if (weatherMeta) {
            weatherMeta.textContent = snapshot.checks.weather.message || 'No weather data loaded.';
        }

        const batteryMeta = document.getElementById('batteryMeta');
        if (batteryMeta) {
            batteryMeta.textContent = snapshot.checks.battery.message || 'Route not evaluated yet.';
        }

        const populationMeta = document.getElementById('populationMeta');
        if (populationMeta) {
            populationMeta.textContent = snapshot.checks.population.message || 'Awaiting density input.';
        }

        const obstacleMeta = document.getElementById('obstacleMeta');
        if (obstacleMeta) {
            obstacleMeta.textContent = snapshot.checks.obstacles.message || 'No route to evaluate.';
        }

        const obstacleList = document.getElementById('obstacleList');
        if (obstacleList) {
            if (snapshot.checks.obstacles.conflicts?.length) {
                const labels = snapshot.checks.obstacles.conflicts.map((hazard) => {
                    const tag = hazard.severity ? ` (${hazard.severity})` : '';
                    return `${hazard.name}${tag}`;
                });
                obstacleList.textContent = `Conflicts: ${labels.join(', ')}`;
            } else {
                obstacleList.textContent = '';
            }
        }
    }

    function setStatusBadge(element, status) {
        if (!element) return;
        const classes = ['pass', 'warn', 'fail', 'pending'];
        element.classList.remove(...classes);
        const labelMap = {
            pass: 'Pass',
            warn: 'Warn',
            fail: 'Fail',
            pending: 'Pending'
        };
        const statusClass = classes.includes(status) ? status : 'pending';
        element.classList.add(statusClass);
        element.textContent = labelMap[statusClass];
    }

    function computeRouteMetrics(waypoints, cruiseSpeed) {
        if (!waypoints || waypoints.length === 0) {
            return { distanceM: 0, estimatedMinutes: 0, hasRoute: false };
        }
        let distanceM = 0;
        for (let i = 1; i < waypoints.length; i += 1) {
            const prev = waypoints[i - 1];
            const next = waypoints[i];
            distanceM += utils.haversineMeters(prev.lat, prev.lon, next.lat, next.lon);
        }
        const speed = cruiseSpeed > 0 ? cruiseSpeed : 0;
        const estimatedMinutes = speed > 0 ? distanceM / speed / 60 : 0;
        return { distanceM, estimatedMinutes, hasRoute: true };
    }

    function formatDistance(distanceM) {
        if (!Number.isFinite(distanceM)) return '--';
        if (distanceM >= 1000) {
            return `${(distanceM / 1000).toFixed(2)} km`;
        }
        return `${Math.round(distanceM)} m`;
    }

    function formatMinutes(minutes) {
        if (!Number.isFinite(minutes)) return '--';
        return `${minutes.toFixed(1)} min`;
    }

    function getNumberValue(id, fallback) {
        const el = document.getElementById(id);
        if (!el) return fallback;
        const value = Number(el.value);
        return Number.isFinite(value) ? value : fallback;
    }

    function fetchWeather() {
        const meta = document.getElementById('weatherMeta');
        if (meta) meta.textContent = 'Fetching weather...';
        runComplianceAnalysis();
    }

    function setInputValue(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        if (Number.isFinite(value)) {
            el.value = value;
        } else if (typeof value === 'string') {
            el.value = value;
        }
    }


    function getBlockingChecks(snapshot) {
        if (!snapshot) return ['Compliance data missing'];
        const labels = {
            weather: 'Weather',
            battery: 'Battery',
            population: 'Population',
            obstacles: 'Obstacles',
            override: 'Override'
        };
        const violationLabels = {
            route: 'Route',
            geofence: 'Geofence',
            altitude: 'Altitude',
            coordinate: 'Coordinates',
            trajectory: 'Trajectory'
        };

        const blockingKeys = Array.isArray(snapshot.blocking) && snapshot.blocking.length
            ? snapshot.blocking
            : Object.entries(snapshot.checks || {})
                .filter(([, check]) => check.status === 'fail' || check.status === 'pending')
                .map(([key]) => key);

        const blockingChecks = blockingKeys.map((key) => labels[key] || key);
        const violations = Array.isArray(snapshot.violations)
            ? snapshot.violations.map((violation) => violationLabels[violation.type] || violation.type || 'Violation')
            : [];

        return Array.from(new Set([...blockingChecks, ...violations]));
    }

    function showMessage(type, message) {
        const container = document.getElementById('missionMessages');
        if (!container) return;
        const colorClass = type === 'error' ? 'status-badge danger' : 'status-badge online';
        container.innerHTML = `
            <div class="${colorClass}" style="margin-bottom: 16px;">
                <span>${escapeHtml(message)}</span>
            </div>
        `;
    }

    function buildGeoJson(minAltitude, maxAltitude, startTime, endTime, complianceSnapshot) {
        const coordinates = getActiveRoute().map((wp) => [wp.lon, wp.lat]);
        let geometry = null;

        if (coordinates.length === 1) {
            geometry = { type: 'Point', coordinates: coordinates[0] };
        } else {
            geometry = { type: 'LineString', coordinates };
        }

        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry,
                    properties: {
                        min_altitude: { meters: minAltitude, datum: 'W84' },
                        max_altitude: { meters: maxAltitude, datum: 'W84' },
                        start_time: startTime,
                        end_time: endTime,
                        compliance: complianceSnapshot || null
                    }
                }
            ]
        };
    }

    async function submitMission() {
        const droneId = document.getElementById('droneSelect')?.value;
        const missionName = document.getElementById('missionName')?.value?.trim();
        const missionType = document.getElementById('missionType')?.value;
        const operationType = Number(document.getElementById('operationType')?.value || 1);
        const startInput = document.getElementById('missionStart')?.value;
        const endInput = document.getElementById('missionEnd')?.value;
        const minAltitude = Number(document.getElementById('minAltitude')?.value || 0);
        const maxAltitude = Number(document.getElementById('maxAltitude')?.value || 0);
        const cruiseSpeed = getNumberValue('cruiseSpeed', 0);
        const cruiseAltitude = Number.isFinite(maxAltitude) && maxAltitude > 0
            ? maxAltitude
            : minAltitude;
        const batteryCapacity = getNumberValue('batteryCapacity', 0);
        const batteryReserve = getNumberValue('batteryReserve', 0);
        const clearanceM = getNumberValue('obstacleClearance', 60);

        if (!droneId) {
            showMessage('error', 'Select a drone before submitting.');
            return;
        }
        if (!missionName) {
            showMessage('error', 'Mission name is required.');
            return;
        }
        if (state.waypoints.length < 2) {
            showMessage('error', 'Add at least two waypoints.');
            return;
        }
        if (!startInput || !endInput) {
            showMessage('error', 'Start and end times are required.');
            return;
        }

        const startTime = new Date(startInput).toISOString();
        const endTime = new Date(endInput).toISOString();

        const complianceSnapshot = await runComplianceAnalysis();
        if (!complianceSnapshot) {
            showMessage('error', 'Compliance data unavailable. Run analysis and try again.');
            return;
        }

        const flightId = generateFlightId();
        const blockingChecks = getBlockingChecks(complianceSnapshot);
        const overrideEnabled = complianceSnapshot.override?.enabled;
        const overrideNotes = complianceSnapshot.override?.notes || '';

        if (blockingChecks.length && !overrideEnabled) {
            showMessage('error', `Compliance checks need attention: ${blockingChecks.join(', ')}.`);
            return;
        }

        if (blockingChecks.length && overrideEnabled && overrideNotes.length < 8) {
            showMessage('error', 'Provide override notes to submit with failed checks.');
            return;
        }

        const activeRoute = getActiveRoute();
        const atcWaypoints = activeRoute.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: Number.isFinite(wp.alt) ? wp.alt : cruiseAltitude
        }));
        const atcRequestWaypoints = activeRoute.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            altitude_m: Number.isFinite(wp.alt) ? wp.alt : cruiseAltitude,
            speed_mps: cruiseSpeed > 0 ? cruiseSpeed : undefined
        }));

        const trajectorySource = Array.isArray(state.optimizedRoute) && state.optimizedRoute.length >= 2
            ? state.optimizedRoute
            : activeRoute;
        const trajectoryLog = trajectorySource.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: Number.isFinite(wp.alt) ? wp.alt : cruiseAltitude
        }));
        const speedMps = cruiseSpeed > 0 ? cruiseSpeed : 0;
        let cumulativeTimeS = 0;
        const trajectoryLogRequest = trajectorySource.map((wp, index) => {
            const altitude = Number.isFinite(wp.alt) ? wp.alt : cruiseAltitude;
            if (index > 0 && speedMps > 0) {
                const prev = trajectorySource[index - 1];
                cumulativeTimeS += utils.haversineMeters(prev.lat, prev.lon, wp.lat, wp.lon) / speedMps;
            }
            return {
                lat: wp.lat,
                lon: wp.lon,
                altitude_m: altitude,
                time_offset_s: speedMps > 0 ? Number(cumulativeTimeS.toFixed(2)) : undefined
            };
        });

        const atcPlanEmbed = {
            id: flightId,
            drone_id: droneId,
            waypoints: atcWaypoints,
            trajectory_log: trajectoryLog,
            metadata: {
                drone_speed_mps: cruiseSpeed > 0 ? cruiseSpeed : undefined,
                battery_capacity_min: Number.isFinite(batteryCapacity) && batteryCapacity > 0 ? batteryCapacity : undefined,
                battery_reserve_min: Number.isFinite(batteryReserve) ? batteryReserve : undefined,
                clearance_m: Number.isFinite(clearanceM) ? clearanceM : undefined,
                operation_type: operationType,
                compliance_override_enabled: overrideEnabled,
                compliance_override_notes: overrideNotes || undefined,
                submitted_at: new Date().toISOString()
            }
        };

        const compliancePayload = {
            ...(complianceSnapshot || {}),
            atc_plan_id: flightId,
            atc_plan: atcPlanEmbed
        };

        const routeAltitudes = activeRoute
            .map((wp) => Number(wp.alt))
            .filter((alt) => Number.isFinite(alt));
        const routeMinAlt = routeAltitudes.length ? Math.min(...routeAltitudes) : minAltitude;
        const routeMaxAlt = routeAltitudes.length ? Math.max(...routeAltitudes) : maxAltitude;

        const flightDeclarationGeoJson = buildGeoJson(routeMinAlt, routeMaxAlt, startTime, endTime, compliancePayload);
        const submittedBy = window.APP_USER?.email || 'guest@example.com';
        const originatingParty = `${missionName} (${missionType})`;

        const payload = {
            flight_declaration_geo_json: flightDeclarationGeoJson,
            start_datetime: startTime,
            end_datetime: endTime,
            submitted_by: submittedBy,
            type_of_operation: operationType,
            originating_party: originatingParty,
            aircraft_id: droneId
        };

        let declarationId = null;
        try {
            const declaration = await API.createFlightDeclaration(payload);
            declarationId = declaration?.id
                || declaration?.flight_declaration_id
                || declaration?.flight_declaration?.id
                || null;
        } catch (error) {
            showMessage('error', `Flight Blender submission failed: ${error.message}`);
            return;
        }

        const metadata = {
            drone_id: droneId,
            blender_declaration_id: declarationId || undefined,
            drone_speed_mps: cruiseSpeed > 0 ? cruiseSpeed : undefined,
            battery_capacity_min: Number.isFinite(batteryCapacity) && batteryCapacity > 0 ? batteryCapacity : undefined,
            battery_reserve_min: Number.isFinite(batteryReserve) ? batteryReserve : undefined,
            clearance_m: Number.isFinite(clearanceM) ? clearanceM : undefined,
            operation_type: operationType,
            compliance_override_enabled: overrideEnabled,
            compliance_override_notes: overrideNotes || undefined
        };
        try {
            await API.reserveOperationalIntent({
                drone_id: droneId,
                waypoints: atcRequestWaypoints,
                trajectory_log: trajectoryLogRequest,
                departure_time: startTime,
                owner_id: window.APP_USER?.id || undefined,
                metadata
            });
        } catch (error) {
            const shouldRollback = declarationId && (!error?.status || error.status >= 500);
            if (shouldRollback) {
                API.deleteFlightDeclaration(declarationId).catch((cleanupError) => {
                    console.warn('[Mission] Failed to rollback Blender declaration:', cleanupError);
                });
                showMessage('error', `ATC reservation failed; attempted Blender rollback. ${error.message}`);
                return;
            }
            showMessage('error', `Flight declaration submitted, but ATC reservation failed: ${error.message}`);
        }

        showMessage('success', 'Flight declaration submitted successfully. ATC slot reserved.');
        setTimeout(() => {
            window.location.href = '/control/missions';
        }, 1200);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
