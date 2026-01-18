/**
 * Mission Planner
 * Creates flight declarations via Flight Blender from waypoint-based routes.
 */

(function () {
    'use strict';

    const CONFIG = {
        CESIUM_ION_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlNzYzZDA0ZC0xMzM2LTRiZDYtOTlmYi00YWZlYWIyMmIzZDQiLCJpZCI6Mzc5MzIwLCJpYXQiOjE3Njg1MTI0NTV9.SFfIGeLNyHKRsAD8oJdDHpNibeSoxx_ISirSN1-xKdg',
        GOOGLE_3D_TILES_ASSET_ID: 2275207,
        DEFAULT_VIEW: { lat: 33.6846, lon: -117.8265, height: 2500 }
    };

    const COMPLIANCE_LIMITS = {
        maxWindMps: 12,
        maxGustMps: 15,
        maxPrecipMm: 2,
        windWarnRatio: 0.8,
        batteryWarnMarginMin: 5,
        populationBvlosMax: 1500,
        populationWarn: 2000,
        populationAbsoluteMax: 4000
    };

    const HAZARDS = [
        { id: 'tower-1', name: 'Campus Tower', lat: 33.6459, lon: -117.8422, heightM: 60, radiusM: 80 },
        { id: 'power-1', name: 'Power Corridor', lat: 33.6835, lon: -117.8302, heightM: 30, radiusM: 120 },
        { id: 'hospital-1', name: 'Helipad Zone', lat: 33.6431, lon: -117.8455, heightM: 40, radiusM: 150 },
        { id: 'stadium-1', name: 'Stadium Complex', lat: 33.6505, lon: -117.8372, heightM: 50, radiusM: 180 }
    ];
    const statusUtils = window.ATCStatus || {
        getStatusLabel: (status) => status || 'Unknown'
    };

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
        populationInfo: null,
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
            'weatherWind',
            'weatherGust',
            'weatherPrecip',
            'weatherMaxWind',
            'weatherMaxGust',
            'weatherMaxPrecip',
            'batteryCapacity',
            'batteryReserve',
            'cruiseSpeed',
            'populationDensity',
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

        const populationClass = document.getElementById('populationClass');
        if (populationClass) {
            populationClass.addEventListener('change', () => {
                applyPopulationPreset(false);
                updateCompliance();
            });
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
                defaultAltitudeM: plannedAltitude
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
                <span>#${index + 1} ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</span>
                <button class="btn btn-ghost btn-sm" data-index="${index}">Remove</button>
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

        const hazards = state.dynamicHazards.length ? state.dynamicHazards : HAZARDS;

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

    function runComplianceAnalysis() {
        if (state.analysisInFlight) return;
        const activeRoute = getActiveRoute();
        if (!activeRoute.length) {
            const populationMeta = document.getElementById('populationMeta');
            const obstacleMeta = document.getElementById('obstacleMeta');
            if (populationMeta) populationMeta.textContent = 'Add at least one waypoint to analyze.';
            if (obstacleMeta) obstacleMeta.textContent = 'Add at least one waypoint to analyze.';
            return;
        }

        const populationMeta = document.getElementById('populationMeta');
        const obstacleMeta = document.getElementById('obstacleMeta');
        if (populationMeta) populationMeta.textContent = 'Analyzing population density...';
        if (obstacleMeta) obstacleMeta.textContent = 'Scanning obstacles near route...';

        const clearance = getNumberValue('obstacleClearance', 60);
        const minAltitude = getNumberValue('minAltitude', 0);
        const maxAltitude = getNumberValue('maxAltitude', 0);
        const operationType = Number(document.getElementById('operationType')?.value || 1);

        state.analysisInFlight = true;
        API.getComplianceAnalysis({
            points: activeRoute.map((wp) => ({ lat: wp.lat, lon: wp.lon })),
            clearance_m: clearance,
            min_altitude_m: minAltitude,
            max_altitude_m: maxAltitude,
            operation_type: operationType
        })
            .then((result) => {
                const population = result?.population || {};
                const density = Number(population.density);
                if (Number.isFinite(density)) {
                    setInputValue('populationDensity', Math.round(density));
                    const classSelect = document.getElementById('populationClass');
                    if (classSelect) {
                        classSelect.value = classifyPopulation(density);
                    }
                    state.populationInfo = {
                        density,
                        classification: population.classification,
                        buildingCount: population.building_count,
                        estimatedPopulation: population.estimated_population,
                        areaKm2: result.area_km2,
                        source: population.source
                    };
                }

                if (Array.isArray(result?.obstacles)) {
                    state.dynamicHazards = result.obstacles.map((hazard) => ({
                        ...hazard,
                        radiusM: hazard.radiusM || hazard.radius_m || 60
                    }));
                    renderHazards();
                }

                updateCompliance();
            })
            .catch((error) => {
                if (populationMeta) populationMeta.textContent = `Analysis failed: ${error.message}`;
                if (obstacleMeta) obstacleMeta.textContent = 'Obstacle scan failed.';
            })
            .finally(() => {
                state.analysisInFlight = false;
            });
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

    function updateCompliance() {
        const snapshot = buildComplianceSnapshot();
        state.compliance = snapshot;
        renderCompliance(snapshot);
        return snapshot;
    }

    function buildComplianceSnapshot() {
        const cruiseSpeed = getNumberValue('cruiseSpeed', 0);
        const route = computeRouteMetrics(getActiveRoute(), cruiseSpeed);
        const weather = evaluateWeather();
        const battery = evaluateBattery(route);
        const population = evaluatePopulation();
        const obstacles = evaluateObstacles();

        const checks = { weather, battery, population, obstacles };
        const overallStatus = summarizeStatus(checks);
        const override = {
            enabled: !!document.getElementById('complianceOverride')?.checked,
            notes: (document.getElementById('complianceNotes')?.value || '').trim()
        };

        return {
            generated_at: new Date().toISOString(),
            overall_status: overallStatus,
            route,
            checks,
            override
        };
    }

    function summarizeStatus(checks) {
        let hasWarn = false;
        let hasPending = false;
        let hasFail = false;

        Object.values(checks).forEach((check) => {
            if (check.status === 'fail') hasFail = true;
            if (check.status === 'pending') hasPending = true;
            if (check.status === 'warn') hasWarn = true;
        });

        if (hasFail) return 'fail';
        if (hasPending) return 'pending';
        if (hasWarn) return 'warn';
        return 'pass';
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
            distanceM += haversineDistanceMeters(prev, next);
        }
        const speed = cruiseSpeed > 0 ? cruiseSpeed : 0;
        const estimatedMinutes = speed > 0 ? distanceM / speed / 60 : 0;
        return { distanceM, estimatedMinutes, hasRoute: true };
    }

    function evaluateWeather() {
        const wind = getNumberValue('weatherWind');
        const gust = getNumberValue('weatherGust');
        const precip = getNumberValue('weatherPrecip');
        const maxWind = getNumberValue('weatherMaxWind', COMPLIANCE_LIMITS.maxWindMps);
        const maxGust = getNumberValue('weatherMaxGust', COMPLIANCE_LIMITS.maxGustMps);
        const maxPrecip = getNumberValue('weatherMaxPrecip', COMPLIANCE_LIMITS.maxPrecipMm);
        const source = document.getElementById('weatherSource')?.value || 'Manual';

        if (!Number.isFinite(wind) || !Number.isFinite(gust) || !Number.isFinite(precip)) {
            return {
                status: 'pending',
                message: 'Provide wind, gust, and precipitation values.',
                windMps: wind,
                gustMps: gust,
                precipMm: precip,
                source
            };
        }

        let status = 'pass';
        if (wind > maxWind || gust > maxGust || precip > maxPrecip) {
            status = 'fail';
        } else if (
            wind > maxWind * COMPLIANCE_LIMITS.windWarnRatio ||
            gust > maxGust * COMPLIANCE_LIMITS.windWarnRatio ||
            precip > maxPrecip * COMPLIANCE_LIMITS.windWarnRatio
        ) {
            status = 'warn';
        }

        return {
            status,
            windMps: wind,
            gustMps: gust,
            precipMm: precip,
            maxWindMps: maxWind,
            maxGustMps: maxGust,
            maxPrecipMm: maxPrecip,
            source,
            message: `Wind ${wind.toFixed(1)} m/s, Gust ${gust.toFixed(1)} m/s, Precip ${precip.toFixed(1)} mm (Source: ${source})`
        };
    }

    function evaluateBattery(route) {
        const capacityMin = getNumberValue('batteryCapacity');
        const reserveMin = getNumberValue('batteryReserve', 0);
        const cruiseSpeed = getNumberValue('cruiseSpeed', 0);

        if (!route.hasRoute || !Number.isFinite(capacityMin) || !Number.isFinite(cruiseSpeed)) {
            return { status: 'pending', message: 'Route not evaluated yet.' };
        }

        const estimatedMinutes = route.estimatedMinutes;
        const remaining = capacityMin - estimatedMinutes;
        let status = 'pass';

        if (remaining < reserveMin) {
            status = 'fail';
        } else if (remaining < reserveMin + COMPLIANCE_LIMITS.batteryWarnMarginMin) {
            status = 'warn';
        }

        return {
            status,
            distanceM: route.distanceM,
            estimatedMinutes,
            cruiseSpeedMps: cruiseSpeed,
            capacityMin,
            reserveMin,
            remainingMin: remaining,
            message: `Distance ${formatDistance(route.distanceM)} | Est ${formatMinutes(estimatedMinutes)} | Remaining ${remaining.toFixed(1)} min`
        };
    }

    function evaluatePopulation() {
        const density = getNumberValue('populationDensity');
        const category = document.getElementById('populationClass')?.value || 'suburban';
        const operationMode = Number(document.getElementById('operationType')?.value || 1) === 2 ? 'BVLOS' : 'VLOS';
        const source = state.populationInfo?.source;
        const buildingCount = state.populationInfo?.buildingCount;
        const areaKm2 = state.populationInfo?.areaKm2;

        if (!Number.isFinite(density)) {
            return { status: 'pending', message: 'Awaiting density input.', density };
        }

        let status = 'pass';
        if (density >= COMPLIANCE_LIMITS.populationAbsoluteMax) {
            status = 'fail';
        } else if (operationMode === 'BVLOS' && density > COMPLIANCE_LIMITS.populationBvlosMax) {
            status = 'fail';
        } else if (density >= COMPLIANCE_LIMITS.populationWarn) {
            status = 'warn';
        }

        return {
            status,
            density,
            category,
            operationMode,
            source,
            message: `Density ${density.toFixed(0)} people/km^2 (${category}, ${operationMode})`
                + (Number.isFinite(buildingCount) && Number.isFinite(areaKm2)
                    ? ` • ${buildingCount} buildings / ${areaKm2.toFixed(2)} km^2`
                    : '')
                + (source ? ` • Source: ${source}` : '')
        };
    }

    function evaluateObstacles() {
        const clearance = getNumberValue('obstacleClearance', 60);
        const minAltitude = getNumberValue('minAltitude', 0);
        const maxAltitude = getNumberValue('maxAltitude', 0);
        const activeRoute = getActiveRoute();

        if (!activeRoute.length) {
            return { status: 'pending', message: 'No route to evaluate.', clearanceM: clearance, conflicts: [] };
        }

        const hazards = state.dynamicHazards.length ? state.dynamicHazards : HAZARDS;
        const conflicts = [];
        const warnings = [];
        let nearest = { name: null, distanceM: Infinity };

        if (state.geofences.length) {
            state.geofences.forEach((geofence) => {
                if (!altitudeOverlaps(minAltitude, maxAltitude, geofence.lower_altitude_m, geofence.upper_altitude_m)) {
                    return;
                }
                const polygon = normalizePolygon(geofence.polygon);
                if (polygon.length < 3) {
                    return;
                }
                const intersects = routeIntersectsPolygon(activeRoute, polygon);
                const distance = distanceRouteToPolygonMeters(activeRoute, polygon);
                if (Number.isFinite(distance) && distance < nearest.distanceM) {
                    nearest = { name: geofence.name, distanceM: distance };
                }
                if (intersects) {
                    conflicts.push({
                        id: geofence.id,
                        name: geofence.name,
                        distanceM: 0,
                        severity: 'conflict'
                    });
                } else if (distance <= clearance) {
                    warnings.push({
                        id: geofence.id,
                        name: geofence.name,
                        distanceM: distance,
                        severity: 'near'
                    });
                }
            });
        }

        hazards.forEach((hazard) => {
            const hazardRadius = hazard.radiusM || 60;
            const distance = distanceToRouteMeters(hazard, activeRoute);
            const conflictThreshold = hazardRadius + clearance;
            const warnThreshold = hazardRadius + clearance * 1.5;
            if (distance < conflictThreshold) {
                conflicts.push({
                    id: hazard.id,
                    name: hazard.name,
                    distanceM: distance,
                    requiredClearanceM: conflictThreshold,
                    severity: 'conflict'
                });
            } else if (distance < warnThreshold) {
                warnings.push({
                    id: hazard.id,
                    name: hazard.name,
                    distanceM: distance,
                    requiredClearanceM: warnThreshold,
                    severity: 'near'
                });
            }
            if (distance < nearest.distanceM) {
                nearest = { name: hazard.name, distanceM: distance };
            }
        });

        const status = conflicts.length ? 'fail' : warnings.length ? 'warn' : 'pass';
        const nearestText = Number.isFinite(nearest.distanceM)
            ? `${nearest.name} at ${formatDistance(nearest.distanceM)}`
            : 'No hazards evaluated';
        const summary = [];
        if (conflicts.length) {
            summary.push(`Conflicts: ${conflicts.map((h) => h.name).join(', ')}`);
        }
        if (!conflicts.length && warnings.length) {
            summary.push(`Near clearance: ${warnings.map((h) => h.name).join(', ')}`);
        }
        if (!summary.length) {
            summary.push(`Nearest hazard: ${nearestText}`);
        }

        return {
            status,
            clearanceM: clearance,
            hazards,
            conflicts: conflicts.concat(warnings),
            nearest,
            message: summary.join(' | ')
        };
    }

    function altitudeOverlaps(minAlt, maxAlt, lowerAlt, upperAlt) {
        const min = Number.isFinite(minAlt) ? minAlt : 0;
        const max = Number.isFinite(maxAlt) ? maxAlt : minAlt;
        const lower = Number.isFinite(lowerAlt) ? lowerAlt : 0;
        const upper = Number.isFinite(upperAlt) ? upperAlt : 0;
        return max >= lower && min <= upper;
    }

    function normalizePolygon(polygon) {
        if (!Array.isArray(polygon)) return [];
        if (polygon.length < 3) return polygon.slice();
        const normalized = polygon.map(([lat, lon]) => ({ lat, lon }));
        const first = normalized[0];
        const last = normalized[normalized.length - 1];
        if (first.lat === last.lat && first.lon === last.lon) {
            normalized.pop();
        }
        return normalized;
    }

    function routeIntersectsPolygon(waypoints, polygon) {
        if (waypoints.length < 2 || polygon.length < 3) return false;
        const refLat = polygon.reduce((sum, p) => sum + p.lat, 0) / polygon.length;
        const polyXY = polygon.map((point) => projectToPlane(point, refLat));

        for (let i = 1; i < waypoints.length; i += 1) {
            const start = projectToPlane(waypoints[i - 1], refLat);
            const end = projectToPlane(waypoints[i], refLat);
            if (pointInPolygon(start, polyXY) || pointInPolygon(end, polyXY)) {
                return true;
            }
            for (let j = 0; j < polyXY.length; j += 1) {
                const a = polyXY[j];
                const b = polyXY[(j + 1) % polyXY.length];
                if (segmentsIntersect(start, end, a, b)) {
                    return true;
                }
            }
        }
        return false;
    }

    function pointInPolygon(point, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x;
            const yi = polygon[i].y;
            const xj = polygon[j].x;
            const yj = polygon[j].y;
            const intersect = ((yi > point.y) !== (yj > point.y)) &&
                (point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 0.0000001) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function segmentsIntersect(p1, p2, q1, q2) {
        const o1 = orientation(p1, p2, q1);
        const o2 = orientation(p1, p2, q2);
        const o3 = orientation(q1, q2, p1);
        const o4 = orientation(q1, q2, p2);

        if (o1 !== o2 && o3 !== o4) {
            return true;
        }

        if (o1 === 0 && onSegment(p1, q1, p2)) return true;
        if (o2 === 0 && onSegment(p1, q2, p2)) return true;
        if (o3 === 0 && onSegment(q1, p1, q2)) return true;
        if (o4 === 0 && onSegment(q1, p2, q2)) return true;

        return false;
    }

    function orientation(a, b, c) {
        const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
        if (Math.abs(value) < 1e-9) return 0;
        return value > 0 ? 1 : 2;
    }

    function onSegment(a, b, c) {
        return b.x <= Math.max(a.x, c.x) &&
            b.x >= Math.min(a.x, c.x) &&
            b.y <= Math.max(a.y, c.y) &&
            b.y >= Math.min(a.y, c.y);
    }

    function distanceRouteToPolygonMeters(waypoints, polygon) {
        let minDistance = Infinity;
        polygon.forEach((vertex) => {
            const distance = distanceToRouteMeters(vertex, waypoints);
            if (distance < minDistance) minDistance = distance;
        });
        return minDistance;
    }

    function distanceToRouteMeters(hazard, waypoints) {
        if (waypoints.length === 1) {
            return haversineDistanceMeters(waypoints[0], hazard);
        }

        let minDistance = Infinity;
        for (let i = 1; i < waypoints.length; i += 1) {
            const start = waypoints[i - 1];
            const end = waypoints[i];
            const distance = distancePointToSegmentMeters(hazard, start, end);
            if (distance < minDistance) minDistance = distance;
        }
        return minDistance;
    }

    function distancePointToSegmentMeters(point, start, end) {
        const refLat = (point.lat + start.lat + end.lat) / 3;
        const p = projectToPlane(point, refLat);
        const a = projectToPlane(start, refLat);
        const b = projectToPlane(end, refLat);
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const apx = p.x - a.x;
        const apy = p.y - a.y;
        const abLenSq = abx * abx + aby * aby;
        if (abLenSq === 0) {
            return Math.hypot(apx, apy);
        }
        const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
        const closestX = a.x + t * abx;
        const closestY = a.y + t * aby;
        return Math.hypot(p.x - closestX, p.y - closestY);
    }

    function projectToPlane(point, refLat) {
        const radLat = toRadians(point.lat);
        const radLon = toRadians(point.lon);
        const radRef = toRadians(refLat);
        const x = 6371000 * radLon * Math.cos(radRef);
        const y = 6371000 * radLat;
        return { x, y };
    }

    function haversineDistanceMeters(a, b) {
        const radLat1 = toRadians(a.lat);
        const radLat2 = toRadians(b.lat);
        const deltaLat = toRadians(b.lat - a.lat);
        const deltaLon = toRadians(b.lon - a.lon);
        const sinLat = Math.sin(deltaLat / 2);
        const sinLon = Math.sin(deltaLon / 2);
        const h = sinLat * sinLat + Math.cos(radLat1) * Math.cos(radLat2) * sinLon * sinLon;
        return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function toRadians(value) {
        return (value * Math.PI) / 180;
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

        const center = getComplianceCenter();
        if (!center) {
            if (meta) meta.textContent = 'Unable to determine a location for weather data.';
            return;
        }

        API.getComplianceWeather(center.lat, center.lon)
            .then((data) => {
                const current = data.current || data.current_weather || {};
                const wind = Number.isFinite(current.wind_speed_10m) ? current.wind_speed_10m : current.wind_speed;
                const gust = Number.isFinite(current.wind_gusts_10m) ? current.wind_gusts_10m : current.wind_gusts;
                const precip = Number.isFinite(current.precipitation) ? current.precipitation : null;

                setInputValue('weatherWind', wind);
                setInputValue('weatherGust', gust);
                setInputValue('weatherPrecip', precip);
                setInputValue('weatherSource', 'Open-Meteo');

                state.weather = {
                    fetchedAt: new Date().toISOString(),
                    source: 'Open-Meteo',
                    data
                };

                updateCompliance();
            })
            .catch((error) => {
                if (meta) meta.textContent = `Weather fetch failed: ${error.message}`;
            });
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

    function getComplianceCenter() {
        const activeRoute = getActiveRoute();
        if (activeRoute.length) {
            const sum = activeRoute.reduce((acc, wp) => {
                acc.lat += wp.lat;
                acc.lon += wp.lon;
                return acc;
            }, { lat: 0, lon: 0 });
            return {
                lat: sum.lat / activeRoute.length,
                lon: sum.lon / activeRoute.length
            };
        }

        if (state.viewer && state.viewer.camera && state.viewer.camera.positionCartographic) {
            const carto = state.viewer.camera.positionCartographic;
            return {
                lat: Cesium.Math.toDegrees(carto.latitude),
                lon: Cesium.Math.toDegrees(carto.longitude)
            };
        }

        return CONFIG.DEFAULT_VIEW;
    }

    function getBlockingChecks(snapshot) {
        if (!snapshot || !snapshot.checks) return ['Compliance data missing'];
        const labels = {
            weather: 'Weather',
            battery: 'Battery',
            population: 'Population',
            obstacles: 'Obstacles'
        };
        return Object.entries(snapshot.checks)
            .filter(([, check]) => check.status === 'fail' || check.status === 'pending')
            .map(([key]) => labels[key] || key);
    }

    function showMessage(type, message) {
        const container = document.getElementById('missionMessages');
        if (!container) return;
        const colorClass = type === 'error' ? 'status-badge danger' : 'status-badge online';
        container.innerHTML = `
            <div class="${colorClass}" style="margin-bottom: 16px;">
                <span>${message}</span>
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

        if (!droneId) {
            showMessage('error', 'Select a drone before submitting.');
            return;
        }
        if (!missionName) {
            showMessage('error', 'Mission name is required.');
            return;
        }
        if (state.waypoints.length === 0) {
            showMessage('error', 'Add at least one waypoint.');
            return;
        }
        if (!startInput || !endInput) {
            showMessage('error', 'Start and end times are required.');
            return;
        }

        const startTime = new Date(startInput).toISOString();
        const endTime = new Date(endInput).toISOString();

        const complianceSnapshot = updateCompliance();
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
        const routeAltitudes = activeRoute
            .map((wp) => Number(wp.alt))
            .filter((alt) => Number.isFinite(alt));
        const routeMinAlt = routeAltitudes.length ? Math.min(...routeAltitudes) : minAltitude;
        const routeMaxAlt = routeAltitudes.length ? Math.max(...routeAltitudes) : maxAltitude;

        const flightDeclarationGeoJson = buildGeoJson(routeMinAlt, routeMaxAlt, startTime, endTime, complianceSnapshot);
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

        const atcWaypoints = activeRoute.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            altitude_m: Number.isFinite(wp.alt) ? wp.alt : cruiseAltitude,
            speed_mps: cruiseSpeed > 0 ? cruiseSpeed : undefined
        }));

        const metadata = declarationId ? { blender_declaration_id: declarationId } : undefined;
        try {
            await API.createFlightPlan({
                drone_id: droneId,
                waypoints: atcWaypoints,
                departure_time: startTime,
                metadata
            });
        } catch (error) {
            showMessage('error', `Declaration submitted, but ATC plan failed: ${error.message}`);
            return;
        }

        showMessage('success', 'Flight declaration submitted successfully.');
        setTimeout(() => {
            window.location.href = '/control/missions';
        }, 1200);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
