/**
 * Mission Detail Page Logic
 */

(function () {
    'use strict';

    const STATE_LABELS = {
        0: 'Not Submitted',
        1: 'Accepted',
        2: 'Activated',
        3: 'Nonconforming',
        4: 'Contingent',
        5: 'Ended',
        6: 'Withdrawn',
        7: 'Cancelled',
        8: 'Rejected'
    };

    const OPERATION_TYPES = {
        1: 'VLOS',
        2: 'BVLOS',
        3: 'EVLOS',
        4: 'Experimental'
    };

    const PLAN_STATUS_LABELS = {
        reserved: 'Reserved',
        pending: 'Pending',
        approved: 'Approved',
        active: 'Active',
        completed: 'Completed',
        rejected: 'Rejected',
        cancelled: 'Cancelled'
    };
    const utils = window.ATCUtils;
    const escapeHtml = window.escapeHtml || ((value) => String(value ?? ''));

    function getPlanTimestamp(plan) {
        const raw = plan?.created_at || plan?.departure_time || plan?.arrival_time || '';
        const ts = Date.parse(raw);
        return Number.isFinite(ts) ? ts : 0;
    }

    function pickLatestPlan(existing, candidate) {
        if (!existing) return candidate;
        if (!candidate) return existing;
        return getPlanTimestamp(candidate) >= getPlanTimestamp(existing) ? candidate : existing;
    }

    function formatDelayMs(delayMs) {
        if (!Number.isFinite(delayMs)) return '--';
        if (delayMs === 0) return 'On time';
        const sign = delayMs >= 0 ? '+' : '-';
        const absSeconds = Math.round(Math.abs(delayMs) / 1000);
        if (absSeconds < 60) return `${sign}${absSeconds}s`;
        const totalMinutes = Math.floor(absSeconds / 60);
        const seconds = absSeconds % 60;
        if (totalMinutes < 60) return `${sign}${totalMinutes}m ${seconds}s`;
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return `${sign}${hours}h ${minutes}m`;
    }

    function findLatestPlan(plans, predicate) {
        let selected = null;
        (plans || []).forEach((plan) => {
            if (!plan || !predicate(plan)) return;
            selected = pickLatestPlan(selected, plan);
        });
        return selected;
    }

    function matchesOwner(mission, owner, droneIds) {
        if (!owner) return true;
        const emailMatch = owner.email
            && utils.normalizeEmail(mission?.submitted_by) === owner.email;
        const droneId = mission?.aircraft_id || '';
        const droneMatch = droneId && droneIds.has(droneId);
        return emailMatch || droneMatch;
    }

    const CesiumConfig = window.__CESIUM_CONFIG__ || {};

    const CONFIG = {
        CESIUM_ION_TOKEN: CesiumConfig.ionToken || '',
        GOOGLE_3D_TILES_ASSET_ID: Number(CesiumConfig.google3dTilesAssetId) || 0,
        DEFAULT_VIEW: { lat: 33.6846, lon: -117.8265, height: 2000 }
    };

    const mapState = {
        viewer: null,
        routeEntity: null,
        waypointEntities: []
    };

    const container = document.getElementById('missionDetail');
    if (!container) return;

    const missionId = container.dataset.missionId;
    if (!missionId) {
        console.error('[MissionDetail] Missing mission ID');
        return;
    }

    function showUnauthorized() {
        container.innerHTML = `
            <div class="empty-state" style="padding: 24px;">
                <div class="empty-state-text text-muted">Mission not available for this operator.</div>
                <div class="text-muted">Return to the missions list to pick another flight.</div>
            </div>
        `;
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function getStatusClass(state) {
        if (state === 2 || state === 3 || state === 4) return 'flying';
        if (state === 5 || state === 6 || state === 7 || state === 8) return 'offline';
        return 'online';
    }

    function computeRouteDistance(waypoints) {
        if (!Array.isArray(waypoints) || waypoints.length < 2) return null;
        let total = 0;
        for (let i = 0; i < waypoints.length - 1; i += 1) {
            total += utils.haversineMeters(
                waypoints[i].lat,
                waypoints[i].lon,
                waypoints[i + 1].lat,
                waypoints[i + 1].lon
            );
        }
        return total;
    }

    const MAX_ROUTE_POINTS = 400;
    const MAX_LIST_POINTS = 20;

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

    function computeProgress(start, end) {
        if (!start || !end) return null;
        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
        const now = Date.now();
        const ratio = Math.min(1, Math.max(0, (now - startMs) / (endMs - startMs)));
        return Math.round(ratio * 100);
    }

    function findPlanForMission(plans, mission) {
        if (!Array.isArray(plans) || !mission) return null;

        const planId = utils.getAtcPlanId(mission);
        if (planId) {
            const match = findLatestPlan(plans, (plan) => plan?.flight_id === planId);
            if (match) return match;
        }

        const declarationId = getDeclarationId(mission, missionId);
        if (declarationId) {
            const match = findLatestPlan(plans, (plan) => {
                const planDeclarationId = plan?.metadata?.blender_declaration_id;
                if (planDeclarationId === null || planDeclarationId === undefined) return false;
                return String(planDeclarationId) === declarationId;
            });
            if (match) return match;
        }

        if (!mission.aircraft_id) return null;
        const candidates = plans.filter((plan) => plan?.drone_id === mission.aircraft_id);
        if (!candidates.length) return null;

        const startMs = Date.parse(mission.start_datetime || '');
        if (Number.isFinite(startMs)) {
            const close = candidates.filter((plan) => {
                const dep = Date.parse(plan.departure_time || '');
                return Number.isFinite(dep) && Math.abs(dep - startMs) <= 30 * 60 * 1000;
            });
            if (close.length) {
                return close.reduce((latest, plan) => pickLatestPlan(latest, plan), null);
            }
        }

        return candidates.reduce((latest, plan) => pickLatestPlan(latest, plan), null);
    }

    async function submitAtcPlan(mission, waypoints) {
        if (!mission?.aircraft_id) {
            alert('Mission has no assigned drone.');
            return;
        }
        if (!Array.isArray(waypoints) || waypoints.length === 0) {
            alert('No route available to submit.');
            return;
        }

        try {
            const declarationId = getDeclarationId(mission, missionId);
            const metadata = buildAtcMetadata(mission, declarationId);
            const plan = await API.reserveOperationalIntent({
                drone_id: mission.aircraft_id,
                waypoints,
                departure_time: mission.start_datetime || undefined,
                metadata
            });
            const requestedMs = Date.parse(mission.start_datetime || '');
            const scheduledMs = Date.parse(plan?.departure_time || '');
            const delayMs = Number.isFinite(requestedMs) && Number.isFinite(scheduledMs)
                ? scheduledMs - requestedMs
                : NaN;
            alert(`ATC slot reserved: ${PLAN_STATUS_LABELS[String(plan.status || '').toLowerCase()] || plan.status} (delay ${formatDelayMs(delayMs)})`);
            await loadMission();
        } catch (error) {
            alert(`Failed to submit ATC plan: ${error.message}`);
        }
    }

    async function confirmAtcPlan(plan) {
        if (!plan?.flight_id) return;
        try {
            await API.confirmOperationalIntent(plan.flight_id);
            alert('ATC slot confirmed.');
            await loadMission();
        } catch (error) {
            alert(`Failed to confirm ATC slot: ${error.message}`);
        }
    }

    async function updateAtcPlan(plan, mission, waypoints) {
        if (!plan?.flight_id) return;
        if (!mission?.aircraft_id) return;
        if (!Array.isArray(waypoints) || waypoints.length === 0) {
            alert('No route available to submit.');
            return;
        }

        const status = String(plan.status || '').toLowerCase();
        if (status !== 'reserved') {
            alert('Only reserved ATC slots can be updated.');
            return;
        }

        try {
            const declarationId = getDeclarationId(mission, missionId);
            const metadata = buildAtcMetadata(mission, declarationId);
            const updated = await API.updateOperationalIntent(plan.flight_id, {
                drone_id: mission.aircraft_id,
                waypoints,
                departure_time: mission.start_datetime || undefined,
                metadata
            });
            const requestedMs = Date.parse(mission.start_datetime || '');
            const scheduledMs = Date.parse(updated?.departure_time || '');
            const delayMs = Number.isFinite(requestedMs) && Number.isFinite(scheduledMs)
                ? scheduledMs - requestedMs
                : NaN;
            alert(`ATC slot updated: ${PLAN_STATUS_LABELS[String(updated.status || '').toLowerCase()] || updated.status} (delay ${formatDelayMs(delayMs)})`);
            await loadMission();
        } catch (error) {
            alert(`Failed to update ATC slot: ${error.message}`);
        }
    }

    async function cancelAtcPlan(plan) {
        if (!plan?.flight_id) return;
        const status = String(plan.status || '').toLowerCase();
        const label = PLAN_STATUS_LABELS[status] || plan.status || 'plan';
        const confirmCancel = confirm(`Cancel ATC ${label}?`);
        if (!confirmCancel) return;
        try {
            await API.cancelOperationalIntent(plan.flight_id);
            alert('ATC slot cancelled.');
            await loadMission();
        } catch (error) {
            alert(`Failed to cancel ATC slot: ${error.message}`);
        }
    }

    function configureAtcUpdateButton(plan, mission, waypoints) {
        const btn = document.getElementById('updateAtcSlot');
        if (!btn) return;
        const status = String(plan?.status || '').toLowerCase();
        if (status === 'reserved' && plan?.flight_id) {
            btn.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Update ATC Slot';
            btn.title = 'Re-run slotting for the latest mission details';
            btn.onclick = () => updateAtcPlan(plan, mission, waypoints);
            return;
        }
        btn.style.display = 'none';
        btn.disabled = true;
        btn.onclick = null;
    }

    function configureAbortButton(plan, mission) {
        const abortBtn = document.getElementById('abortMission');
        if (!abortBtn) return;

        const hasDrone = !!mission?.aircraft_id;
        if (!hasDrone) {
            abortBtn.disabled = true;
            abortBtn.onclick = null;
            return;
        }

        const missionState = Number(mission?.state);
        const inFlight = missionState === 2 || missionState === 3 || missionState === 4;
        const ended = missionState === 5 || missionState === 6 || missionState === 7 || missionState === 8;
        const planStatus = String(plan?.status || '').toLowerCase();
        const canCancelPlan = plan && (planStatus === 'reserved' || planStatus === 'approved');

        if (ended) {
            abortBtn.disabled = true;
            abortBtn.textContent = 'Abort Mission';
            abortBtn.className = 'btn btn-warning';
            abortBtn.onclick = null;
            return;
        }

        if (!inFlight && canCancelPlan) {
            abortBtn.disabled = false;
            abortBtn.textContent = 'Cancel ATC Slot';
            abortBtn.className = 'btn btn-danger';
            abortBtn.onclick = () => cancelAtcPlan(plan);
            return;
        }

        abortBtn.disabled = false;
        abortBtn.textContent = 'Abort Mission';
        abortBtn.className = 'btn btn-warning';
        abortBtn.onclick = async () => {
            const confirmAbort = confirm(`Abort mission and hold ${mission.aircraft_id}?`);
            if (!confirmAbort) return;
            try {
                await API.holdDrone(mission.aircraft_id, 999);
                alert(`Hold command sent to ${mission.aircraft_id}`);
            } catch (error) {
                alert(`Failed to abort mission: ${error.message}`);
            }
        };
    }

    function updateApproveButton(plan, mission, waypoints) {
        const approveBtn = document.getElementById('approveMission');
        if (!approveBtn) return;

        if (!mission?.aircraft_id) {
            approveBtn.disabled = true;
            approveBtn.textContent = 'No Drone Assigned';
            approveBtn.title = 'Assign a drone before submitting to ATC';
            return;
        }

        if (plan) {
            const status = String(plan.status || '').toLowerCase();
            const label = PLAN_STATUS_LABELS[status] || 'Unknown';
            if (status === 'reserved') {
                approveBtn.disabled = false;
                approveBtn.textContent = 'Confirm ATC Slot';
                approveBtn.title = 'Confirm this reserved ATC slot for execution';
                approveBtn.onclick = () => confirmAtcPlan(plan);
                return;
            }
            if (status === 'rejected' || status === 'cancelled') {
                approveBtn.disabled = false;
                approveBtn.textContent = 'Reserve with ATC';
                approveBtn.title = `Previous ATC plan: ${label}`;
                approveBtn.onclick = () => submitAtcPlan(mission, waypoints);
                return;
            }
            approveBtn.disabled = true;
            approveBtn.textContent = `ATC Plan: ${label}`;
            approveBtn.title = plan.status || '';
            return;
        }

        approveBtn.disabled = false;
        approveBtn.textContent = 'Reserve with ATC';
        approveBtn.title = 'Reserve an ATC slot for this mission';
        approveBtn.onclick = () => submitAtcPlan(mission, waypoints);
    }

    async function initMap() {
        const mapEl = document.getElementById('missionDetailMap');
        if (!mapEl || mapState.viewer) return;

        Cesium.Ion.defaultAccessToken = CONFIG.CESIUM_ION_TOKEN;
        mapState.viewer = new Cesium.Viewer(mapEl, {
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

        mapState.viewer.scene.globe.enableLighting = true;

        try {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(CONFIG.GOOGLE_3D_TILES_ASSET_ID);
            mapState.viewer.scene.primitives.add(tileset);
        } catch (error) {
            const esriImagery = new Cesium.UrlTemplateImageryProvider({
                url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                credit: 'Esri'
            });
            mapState.viewer.imageryLayers.addImageryProvider(esriImagery);
        }

	        mapState.viewer.camera.setView({
	            destination: Cesium.Cartesian3.fromDegrees(
	                CONFIG.DEFAULT_VIEW.lon,
                CONFIG.DEFAULT_VIEW.lat,
                CONFIG.DEFAULT_VIEW.height
            ),
            orientation: {
                heading: Cesium.Math.toRadians(0),
                pitch: Cesium.Math.toRadians(-40),
	                roll: 0
	            }
	        });

	        if (window.ATCCameraControls && typeof window.ATCCameraControls.attach === 'function') {
	            window.ATCCameraControls.attach(mapState.viewer);
	        }
	    }

    function clearRoute() {
        if (!mapState.viewer) return;
        mapState.waypointEntities.forEach((entity) => mapState.viewer.entities.remove(entity));
        mapState.waypointEntities = [];
        if (mapState.routeEntity) {
            mapState.viewer.entities.remove(mapState.routeEntity);
            mapState.routeEntity = null;
        }
    }

    function renderRoute(waypoints) {
        if (!mapState.viewer || !Array.isArray(waypoints) || waypoints.length === 0) return;
        clearRoute();

        const positions = waypoints.map((wp) => Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.altitude_m || 0));
        mapState.waypointEntities = waypoints.map((wp, index) => mapState.viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.altitude_m || 0),
            point: {
                pixelSize: 9,
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
            mapState.routeEntity = mapState.viewer.entities.add({
                polyline: {
                    positions,
                    width: 3,
                    material: Cesium.Color.fromCssColorString('#22c55e')
                }
            });
        }

        zoomToRoute(waypoints);
    }

    function zoomToRoute(waypoints) {
        if (!mapState.viewer || waypoints.length === 0) return;
        if (waypoints.length === 1) {
            const wp = waypoints[0];
            mapState.viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, 1500),
                duration: 1.0
            });
            return;
        }

        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLon = Infinity;
        let maxLon = -Infinity;

        waypoints.forEach((wp) => {
            minLat = Math.min(minLat, wp.lat);
            maxLat = Math.max(maxLat, wp.lat);
            minLon = Math.min(minLon, wp.lon);
            maxLon = Math.max(maxLon, wp.lon);
        });

        if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return;
        const rectangle = Cesium.Rectangle.fromDegrees(minLon, minLat, maxLon, maxLat);
        mapState.viewer.camera.flyTo({ destination: rectangle, duration: 1.0 });
    }

    function extractCoordinates(geo) {
        if (!geo || !Array.isArray(geo.features)) return [];
        const coords = [];
        geo.features.forEach((feature) => {
            const geometry = feature?.geometry;
            if (!geometry) return;
            const { type, coordinates } = geometry;
            if (!coordinates) return;
            if (type === 'Point') {
                coords.push(coordinates);
            } else if (type === 'LineString') {
                coords.push(...coordinates);
            } else if (type === 'Polygon') {
                const ring = coordinates[0] || [];
                coords.push(...ring);
            } else if (type === 'MultiLineString') {
                const first = coordinates[0] || [];
                coords.push(...first);
            } else if (type === 'MultiPolygon') {
                const ring = coordinates?.[0]?.[0] || [];
                coords.push(...ring);
            }
        });
        return coords.filter((coord) => Array.isArray(coord) && coord.length >= 2);
    }

    function getAltitudeFromGeoJson(geo) {
        const feature = geo?.features?.[0];
        const minAlt = Number(feature?.properties?.min_altitude?.meters);
        const maxAlt = Number(feature?.properties?.max_altitude?.meters);
        if (Number.isFinite(maxAlt) && maxAlt > 0) return maxAlt;
        if (Number.isFinite(minAlt) && minAlt > 0) return minAlt;
        return 60;
    }

    function getCruiseSpeedFromGeoJson(geo) {
        const compliance = geo?.features?.[0]?.properties?.compliance;
        const speed = Number(compliance?.checks?.battery?.cruiseSpeedMps);
        return Number.isFinite(speed) && speed > 0 ? speed : null;
    }

    function buildWaypointsFromGeoJson(geo) {
        const coords = extractCoordinates(geo);
        if (!coords.length) return [];
        const altitude = getAltitudeFromGeoJson(geo);
        const speed = getCruiseSpeedFromGeoJson(geo);
        return coords.map((coord) => ({
            lon: coord[0],
            lat: coord[1],
            altitude_m: altitude,
            speed_mps: speed ?? undefined
        }));
    }

    function getDeclarationId(mission, fallbackId = null) {
        const id = mission?.id || mission?.pk || fallbackId;
        return id !== null && id !== undefined ? String(id) : null;
    }

    function getComplianceFromMission(mission) {
        const geo = utils.parseGeoJson(
            mission?.flight_declaration_geojson
            || mission?.flight_declaration_geo_json
            || mission?.flight_declaration_raw_geojson
        );
        return geo?.features?.[0]?.properties?.compliance || null;
    }

    function buildAtcMetadata(mission, declarationId) {
        const compliance = getComplianceFromMission(mission);
        const battery = compliance?.checks?.battery || {};
        const obstacles = compliance?.checks?.obstacles || {};
        const override = compliance?.override || {};
        const cruiseSpeed = Number(battery.cruiseSpeedMps);
        const capacityMin = Number(battery.capacityMin);
        const reserveMin = Number(battery.reserveMin);
        const clearanceM = Number(obstacles.clearanceM);

        return {
            blender_declaration_id: declarationId || undefined,
            drone_speed_mps: Number.isFinite(cruiseSpeed) && cruiseSpeed > 0 ? cruiseSpeed : undefined,
            battery_capacity_min: Number.isFinite(capacityMin) ? capacityMin : undefined,
            battery_reserve_min: Number.isFinite(reserveMin) ? reserveMin : undefined,
            clearance_m: Number.isFinite(clearanceM) ? clearanceM : undefined,
            operation_type: Number(mission?.type_of_operation || 1),
            compliance_override_enabled: !!override.enabled,
            compliance_override_notes: override.notes || undefined
        };
    }

    async function loadMission() {
        const owner = utils.getOwnerContext();
        const ownerId = owner?.id || null;
        let visibleDroneIds = new Set();
        let mission;
        try {
            mission = await API.getFlightDeclaration(missionId);
        } catch (error) {
            console.error('[MissionDetail] Failed to load mission:', error);
            setText('missionName', 'Unknown');
            return;
        }

        if (owner) {
            const drones = await API.getDrones(ownerId).catch(() => []);
            visibleDroneIds = new Set((drones || []).map((drone) => drone.drone_id));
            if (!matchesOwner(mission, owner, visibleDroneIds)) {
                showUnauthorized();
                return;
            }
        }

        const [conformance, plans] = await Promise.all([
            API.getConformance(ownerId).catch(() => []),
            API.getFlightPlans().catch(() => [])
        ]);

        const conformanceMap = new Map((conformance || []).map(entry => [entry.drone_id, entry]));
        const scopedPlans = owner
            ? (plans || []).filter((plan) => {
                if (plan?.owner_id && plan.owner_id === owner.id) return true;
                return visibleDroneIds.has(plan?.drone_id);
            })
            : plans;
        const plan = findPlanForMission(scopedPlans || [], mission);
        const geo = utils.parseGeoJson(
            mission.flight_declaration_geojson
            || mission.flight_declaration_geo_json
            || mission.flight_declaration_raw_geojson
        );
        const derivedWaypoints = geo ? buildWaypointsFromGeoJson(geo) : [];
        const planWaypoints = Array.isArray(plan?.waypoints) ? plan.waypoints : [];
        const trajectoryWaypoints = Array.isArray(plan?.trajectory_log)
            ? sampleWaypoints(plan.trajectory_log, MAX_ROUTE_POINTS)
            : [];
        const mapWaypoints = trajectoryWaypoints.length
            ? trajectoryWaypoints
            : planWaypoints.length
                ? planWaypoints
                : derivedWaypoints;
        const listSource = planWaypoints.length
            ? planWaypoints
            : derivedWaypoints.length
                ? derivedWaypoints
                : trajectoryWaypoints;
        const listWaypoints = sampleWaypoints(listSource, MAX_LIST_POINTS);
        const planMetadata = plan?.metadata || null;

        const missionIdText = getDeclarationId(mission, missionId) || '';
        const missionName = mission.originating_party || (missionIdText ? `Mission ${missionIdText.slice(0, 8)}` : 'Mission');
        setText('missionName', missionName);

        const statusLabel = STATE_LABELS[mission.state] || 'Unknown';
        const statusBadge = document.getElementById('missionStatus');
        const statusDot = container.querySelector('.status-dot');
        const statusClass = getStatusClass(mission.state);
        if (statusBadge) {
            statusBadge.textContent = statusLabel;
            statusBadge.className = `status-badge ${statusClass}`;
        }
        if (statusDot) {
            statusDot.className = `status-dot ${statusClass}`;
        }

        const typeLabel = OPERATION_TYPES[mission.type_of_operation] || `Type ${mission.type_of_operation ?? '--'}`;
        setText('droneId', mission.aircraft_id || '--');
        setText('missionType', typeLabel);
        setText('createdAt', utils.formatDateTime(mission.created_at || mission.updated_at || mission.start_datetime));
        setText('startedAt', utils.formatDateTime(mission.start_datetime));
        const requestedAtc = plan?.metadata?.requested_departure_time || mission.start_datetime || '';
        setText('atcRequested', utils.formatDateTime(requestedAtc));
        setText('atcScheduled', plan?.departure_time ? utils.formatDateTime(plan.departure_time) : '--');
        const requestedMs = Date.parse(requestedAtc || '');
        const scheduledMs = Date.parse(plan?.departure_time || '');
        const delayMs = Number.isFinite(requestedMs) && Number.isFinite(scheduledMs)
            ? scheduledMs - requestedMs
            : NaN;
        setText('atcDelay', formatDelayMs(delayMs));
        const expiresAt = plan?.status === 'reserved'
            ? plan?.metadata?.reservation_expires_at
            : null;
        setText('atcExpires', expiresAt ? utils.formatDateTime(expiresAt) : '--');

        const progress = computeProgress(mission.start_datetime, mission.end_datetime);
        setText('progress', progress !== null ? `${progress}%` : '--');
        setText('eta', mission.end_datetime ? utils.formatDateTime(mission.end_datetime) : '--');

        if (mapWaypoints.length) {
            const distance = computeRouteDistance(mapWaypoints);
            setText('distance', distance !== null ? `${(distance / 1000).toFixed(2)} km` : '--');
            const waypointCount = listSource.length || mapWaypoints.length;
            setText('waypoints', `${waypointCount} total`);
            if (plan.departure_time && plan.arrival_time) {
                const durationMs = Date.parse(plan.arrival_time) - Date.parse(plan.departure_time);
                if (Number.isFinite(durationMs) && durationMs > 0) {
                    const mins = Math.round(durationMs / 60000);
                    setText('duration', `${mins} min`);
                }
            }
            const waypointList = document.getElementById('waypointList');
            if (waypointList) {
                waypointList.innerHTML = listWaypoints.map((wp, index) => {
                    const label = index === 0
                        ? 'Waypoint 1 (Start)'
                        : index === listWaypoints.length - 1
                            ? `Waypoint ${index + 1} (End)`
                            : `Waypoint ${index + 1}`;
                    const altitude = Number.isFinite(wp.altitude_m) ? wp.altitude_m.toFixed(0) : '--';
                    return `
                        <div class="list-item">
                            <span class="status-dot online"></span>
                            <div class="list-item-content">
                                <div class="list-item-title">${escapeHtml(label)}</div>
                                <div class="list-item-subtitle">${escapeHtml(wp.lat.toFixed(5))}, ${escapeHtml(wp.lon.toFixed(5))} @ ${escapeHtml(altitude)}m</div>
                            </div>
                            <span class="status-badge online">Planned</span>
                        </div>
                    `;
                }).join('');
            }
        }

        if (planMetadata) {
            const metadataDistance = Number(planMetadata.total_distance_m);
            if (Number.isFinite(metadataDistance) && metadataDistance > 0) {
                setText('distance', `${(metadataDistance / 1000).toFixed(2)} km`);
            }

            const metadataDuration = Number(planMetadata.total_flight_time_s);
            if (Number.isFinite(metadataDuration) && metadataDuration > 0) {
                const mins = Math.round(metadataDuration / 60);
                setText('duration', `${mins} min`);
            }

            const complianceValue = planMetadata.faa_compliant;
            setText('plannerCompliance',
                complianceValue === true ? 'Compliant' : complianceValue === false ? 'Noncompliant' : '--'
            );

            const speed = Number(planMetadata.drone_speed_mps);
            setText('plannerSpeed', Number.isFinite(speed) ? `${speed.toFixed(1)} m/s` : '--');

            const altitude = Number(planMetadata.planned_altitude_m);
            setText('plannerAltitude', Number.isFinite(altitude) ? `${altitude.toFixed(0)} m` : '--');

            const obstacle = Number(planMetadata.max_obstacle_height_m);
            setText('plannerObstacle', Number.isFinite(obstacle) ? `${obstacle.toFixed(1)} m` : '--');
        }

        await initMap();
        renderRoute(mapWaypoints);
        updateApproveButton(plan, mission, mapWaypoints);
        configureAtcUpdateButton(plan, mission, mapWaypoints);
        configureAbortButton(plan, mission);

        const conformanceEntry = conformanceMap.get(mission.aircraft_id);
        const conformanceStatus = conformanceEntry?.status || 'unknown';
        const conformanceLabel = conformanceStatus === 'conforming'
            ? 'Conforming'
            : conformanceStatus === 'nonconforming'
                ? 'Nonconforming'
                : 'Unknown';
        const conformanceEl = document.getElementById('conformanceStatus');
        if (conformanceEl) {
            conformanceEl.textContent = conformanceLabel;
            conformanceEl.className = `detail-value status-badge ${utils.getConformanceClass(conformanceStatus)}`;
        }
        setText('conformanceCode', conformanceEntry?.record?.conformance_state_code || '--');
        setText('conformanceDescription', conformanceEntry?.record?.description || '--');
        setText('conformanceUpdated', utils.formatDateTime(conformanceEntry?.last_checked));

        const approveBtn = document.getElementById('approveMission');
        if (approveBtn && approveBtn.disabled && !approveBtn.title) {
            approveBtn.title = 'Approval handled in Flight Blender';
        }
    }

    document.addEventListener('DOMContentLoaded', loadMission);
})();
