/**
 * Fleet Page Logic
 */

(function () {
    'use strict';

    const REFRESH_INTERVAL = 3000;
    const statusUtils = window.ATCStatus || {
        isFlyingStatus: () => false,
        isOnlineStatus: (status) => String(status || '').toLowerCase() !== 'lost',
        getStatusClass: () => 'online',
        getStatusLabel: (status) => status || 'Unknown'
    };
    let selectedDroneId = null;
    let conformanceByDrone = new Map();
    let registerInFlight = false;

    /**
     * Load and display drone fleet
     */
    async function loadFleet() {
        try {
            const [drones, conformance] = await Promise.all([
                API.getDrones(),
                API.getConformance().catch(() => [])
            ]);

            // Update stats
            const online = drones.filter(d => statusUtils.isOnlineStatus(d.status)).length;
            const flying = drones.filter(d => statusUtils.isFlyingStatus(d.status)).length;
            const offline = drones.filter(d => statusUtils.getStatusClass(d.status) === 'offline').length;
            const nonconforming = conformance.filter(c => c.status === 'nonconforming').length;

            updateElement('fleetOnline', online);
            updateElement('fleetFlying', flying);
            updateElement('fleetNonconforming', nonconforming);
            updateElement('fleetOffline', offline);

            // Update drone list
            conformanceByDrone = new Map(conformance.map(entry => [entry.drone_id, entry]));
            renderDroneList(drones, conformanceByDrone);

        } catch (error) {
            console.error('[Fleet] Load failed:', error);
        }
    }

    function updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function renderDroneList(drones, conformanceMap) {
        const container = document.getElementById('droneList');
        if (!container) return;

        if (!drones || drones.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">No drones registered</div>
                    <button class="btn btn-primary mt-md" id="addFirstDrone">Add Your First Drone</button>
                </div>
            `;
            const addFirstBtn = document.getElementById('addFirstDrone');
            if (addFirstBtn) {
                addFirstBtn.addEventListener('click', registerDrone);
            }
            return;
        }

        container.innerHTML = drones.map(drone => {
            const conformance = conformanceMap?.get(drone.drone_id);
            const conformanceStatus = conformance?.status || 'unknown';
            const conformanceClass = getConformanceClass(conformanceStatus);
            const statusLabel = statusUtils.getStatusLabel(drone.status);
            return `
            <div class="list-item" data-drone-id="${drone.drone_id}">
                <span class="status-dot ${getStatusClass(drone.status)}"></span>
                <div class="list-item-content">
                    <div class="list-item-title">${drone.drone_id}</div>
                    <div class="list-item-subtitle">
                        Status: ${statusLabel} | 
                        Position: ${drone.lat.toFixed(4)}, ${drone.lon.toFixed(4)} @ ${drone.altitude_m.toFixed(0)}m |
                        Speed: ${drone.speed_mps.toFixed(1)} m/s
                    </div>
                </div>
                <div class="list-item-actions">
                    <span class="status-badge ${getStatusClass(drone.status)}">${statusLabel}</span>
                    <span class="status-badge ${conformanceClass}">${conformanceStatus}</span>
                    <button class="btn btn-ghost btn-sm" onclick="Fleet.viewOnMap('${drone.drone_id}')">
                        Map
                    </button>
                    <button class="btn btn-ghost btn-sm" onclick="Fleet.showDetails('${drone.drone_id}')">
                        Details
                    </button>
                </div>
            </div>
        `;
        }).join('');
    }

    async function registerDrone() {
        if (registerInFlight) return;
        registerInFlight = true;

        const ownerId = window.APP_USER?.id || null;
        const provided = window.prompt('Drone ID (optional). Leave blank to auto-generate:');
        const droneId = provided && provided.trim() ? provided.trim() : null;

        try {
            const response = await API.registerDrone(droneId, ownerId);
            const id = response?.drone_id || droneId || 'New drone';
            alert(`Registered ${id}. Connect your drone SDK to start sending telemetry.`);
            loadFleet();
        } catch (error) {
            alert(`Failed to register drone: ${error.message}`);
        } finally {
            registerInFlight = false;
        }
    }

    function showDetails(droneId) {
        selectedDroneId = droneId;
        const sidebar = document.getElementById('droneDetailSidebar');
        const nameEl = document.getElementById('sidebarDroneName');
        const contentEl = document.getElementById('sidebarContent');

        if (sidebar) sidebar.style.display = 'flex';
        if (nameEl) nameEl.textContent = droneId;

        // Fetch and display drone details
        API.getDrones().then(drones => {
            const drone = drones.find(d => d.drone_id === droneId);
            const conformance = conformanceByDrone.get(droneId);
            const conformanceStatus = conformance?.status || 'unknown';
            const conformanceClass = getConformanceClass(conformanceStatus);
            if (drone && contentEl) {
                const statusLabel = statusUtils.getStatusLabel(drone.status);
                contentEl.innerHTML = `
                    <div class="section-subtitle">Status</div>
                    <div class="flex items-center gap-sm mb-md">
                        <span class="status-dot ${getStatusClass(drone.status)}"></span>
                        <span class="status-badge ${getStatusClass(drone.status)}">${statusLabel}</span>
                    </div>

                    <div class="section-subtitle">Conformance</div>
                    <div class="flex items-center gap-sm mb-md">
                        <span class="status-badge ${conformanceClass}">${conformanceStatus}</span>
                    </div>
                    
                    <div class="section-subtitle">Position</div>
                    <div class="font-mono text-secondary mb-md" style="font-size: 12px;">
                        <div>Latitude: ${drone.lat.toFixed(6)}</div>
                        <div>Longitude: ${drone.lon.toFixed(6)}</div>
                        <div>Altitude: ${drone.altitude_m.toFixed(1)}m</div>
                        <div>Heading: ${drone.heading_deg.toFixed(0)}deg</div>
                        <div>Speed: ${drone.speed_mps.toFixed(1)} m/s</div>
                    </div>
                    
                    <div class="section-subtitle">Commands</div>
                    <div class="flex gap-sm">
                        <button class="btn btn-warning btn-sm" onclick="Fleet.holdDrone('${droneId}')">
                            HOLD
                        </button>
                        <button class="btn btn-success btn-sm" onclick="Fleet.resumeDrone('${droneId}')">
                            RESUME
                        </button>
                    </div>
                `;
            }
        });
    }

    function closeSidebar() {
        const sidebar = document.getElementById('droneDetailSidebar');
        if (sidebar) sidebar.style.display = 'none';
        selectedDroneId = null;
    }

    async function holdDrone(droneId) {
        try {
            await API.holdDrone(droneId, 30);
            console.log(`HOLD command sent to ${droneId}`);
            loadFleet();
        } catch (error) {
            console.error(`Failed to send HOLD: ${error.message}`);
        }
    }

    async function resumeDrone(droneId) {
        try {
            await API.resumeDrone(droneId);
            console.log(`RESUME command sent to ${droneId}`);
            loadFleet();
        } catch (error) {
            console.error(`Failed to send RESUME: ${error.message}`);
        }
    }

    function viewOnMap(droneId) {
        window.location.href = `/control/map?track=${droneId}`;
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

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
        loadFleet();
        setInterval(loadFleet, REFRESH_INTERVAL);

        // Close sidebar button
        const closeBtn = document.getElementById('closeSidebar');
        if (closeBtn) {
            closeBtn.addEventListener('click', closeSidebar);
        }

        // Refresh button
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', loadFleet);
        }

        const addBtn = document.getElementById('addDroneBtn');
        if (addBtn) {
            addBtn.addEventListener('click', registerDrone);
        }
    });

    // Export for global access
    window.Fleet = {
        showDetails,
        holdDrone,
        resumeDrone,
        viewOnMap
    };
})();
