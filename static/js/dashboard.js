/**
 * Dashboard Page Logic
 */

(function () {
    'use strict';

    // Refresh interval (5 seconds)
    const REFRESH_INTERVAL = 5000;
    const statusUtils = window.ATCStatus || {
        isFlyingStatus: () => false,
        getStatusClass: () => 'online',
        getStatusLabel: (status) => status || 'Unknown'
    };

    /**
     * Update dashboard with latest stats
     */
    async function refreshDashboard() {
        try {
            const stats = await API.getStats();
            if (!stats) return;

            // Update stat cards
            updateElement('statDronesOnline', stats.dronesOnline);
            updateElement('statActiveMissions', stats.dronesFlying);
            updateElement('statConflicts', stats.conflicts);
            updateElement('statNonconforming', stats.conformanceNoncompliant ?? 0);
            updateElement('statGeofences', stats.geofences);

            // Update fleet overview
            updateFleetOverview(stats.drones, stats.conformanceData);

            // Update activity feed
            updateActivityFeed(stats);

            // Update alerts
            updateAlerts(stats);

        } catch (error) {
            console.error('[Dashboard] Refresh failed:', error);
        }
    }

    function updateElement(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function updateFleetOverview(drones, conformance) {
        const container = document.getElementById('fleetOverview');
        if (!container) return;

        if (!drones || drones.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">No drones connected</div>
                </div>
            `;
            return;
        }

        const conformanceMap = new Map((conformance || []).map(entry => [entry.drone_id, entry]));

        container.innerHTML = drones.slice(0, 5).map(drone => {
            const conformanceStatus = conformanceMap.get(drone.drone_id)?.status || 'unknown';
            const conformanceClass = getConformanceClass(conformanceStatus);
            const statusLabel = statusUtils.getStatusLabel(drone.status);
            return `
                <div class="list-item">
                    <span class="status-dot ${getStatusClass(drone.status)}"></span>
                    <div class="list-item-content">
                        <div class="list-item-title">${drone.drone_id}</div>
                        <div class="list-item-subtitle">
                            ${drone.lat.toFixed(5)}, ${drone.lon.toFixed(5)} @ ${drone.altitude_m.toFixed(0)}m
                        </div>
                    </div>
                    <span class="status-badge ${getStatusClass(drone.status)}">${statusLabel}</span>
                    <span class="status-badge ${conformanceClass}">${conformanceStatus}</span>
                </div>
            `;
        }).join('');
    }

    function updateActivityFeed(stats) {
        const container = document.getElementById('activityFeed');
        if (!container) return;

        const activities = [];

        // Generate activities from current state
        stats.drones.forEach(drone => {
            if (statusUtils.isFlyingStatus(drone.status)) {
                activities.push({
                    text: `${drone.drone_id} is flying`,
                    time: 'now'
                });
            }
        });

        if (stats.conflicts > 0) {
            activities.push({
                text: `${stats.conflicts} conflict(s) detected`,
                time: 'now'
            });
        }

        if ((stats.conformanceNoncompliant ?? 0) > 0) {
            activities.push({
                text: `${stats.conformanceNoncompliant} nonconforming flight(s)`,
                time: 'now'
            });
        }

        if (activities.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">No recent activity</div>
                </div>
            `;
            return;
        }

        container.innerHTML = activities.map(a => `
            <div class="list-item" style="padding: 8px 12px;">
                <div class="list-item-content">
                    <div class="list-item-subtitle">${a.text}</div>
                </div>
                <span class="text-muted" style="font-size: 11px;">${a.time}</span>
            </div>
        `).join('');
    }

    function updateAlerts(stats) {
        const container = document.getElementById('alertsPanel');
        if (!container) return;

        if (stats.conflicts === 0 && (stats.conformanceNoncompliant ?? 0) === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">No active alerts</div>
                </div>
            `;
            return;
        }

        const alerts = [];
        if (stats.conflicts > 0) {
            alerts.push(`
                <div class="list-item" style="background: rgba(239, 68, 68, 0.1); border-color: var(--accent-red);">
                    <div class="list-item-content">
                        <div class="list-item-title text-danger">${stats.conflicts} Active Conflict(s)</div>
                        <div class="list-item-subtitle">Automatic resolution in progress</div>
                    </div>
                    <a href="/control/map" class="btn btn-danger btn-sm">View Map</a>
                </div>
            `);
        }

        if ((stats.conformanceNoncompliant ?? 0) > 0) {
            alerts.push(`
                <div class="list-item" style="background: rgba(251, 191, 36, 0.1); border-color: var(--accent-yellow);">
                    <div class="list-item-content">
                        <div class="list-item-title">${stats.conformanceNoncompliant} Nonconforming Flight(s)</div>
                        <div class="list-item-subtitle">Review conformance status</div>
                    </div>
                    <a href="/control/fleet" class="btn btn-warning btn-sm">View Fleet</a>
                </div>
            `);
        }

        container.innerHTML = alerts.join('');
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
        refreshDashboard();
        setInterval(refreshDashboard, REFRESH_INTERVAL);

        // Refresh button
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', refreshDashboard);
        }
    });
})();
