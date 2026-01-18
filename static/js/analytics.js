/**
 * Analytics Page Logic
 */

(function () {
    'use strict';

    const ACTIVE_STATES = new Set([2, 3, 4]);
    const COMPLETED_STATES = new Set([5, 6, 7, 8]);
    const SUCCESS_STATES = new Set([5]);
    const DAY_MS = 24 * 60 * 60 * 1000;

    let charts = {};
    let latestReport = null;

    function getOwnerContext() {
        const user = window.APP_USER;
        if (!user || user.role === 'authority') return null;
        const email = (user.email || '').trim().toLowerCase();
        return { id: user.id || null, email: email || null };
    }

    function normalizeEmail(value) {
        return String(value || '').trim().toLowerCase();
    }

    function filterDeclarationsByOwner(declarations, owner, droneIds) {
        if (!owner) return declarations;
        return (declarations || []).filter((decl) => {
            const emailMatch = owner.email
                && normalizeEmail(decl?.submitted_by) === owner.email;
            const droneId = decl?.aircraft_id || '';
            const droneMatch = droneId && droneIds.has(droneId);
            return emailMatch || droneMatch;
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        if (typeof Chart === 'undefined') {
            console.error('[Analytics] Chart.js not loaded');
            return;
        }

        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = '#334155';

        const dateRange = document.getElementById('dateRange');
        if (dateRange) {
            dateRange.addEventListener('change', () => {
                refreshAnalytics();
            });
        }

        refreshAnalytics();
    });

    async function refreshAnalytics() {
        setLoadingState();

        const range = getDateRange();
        const owner = getOwnerContext();
        const ownerId = owner?.id || null;
        const [declarations, conflicts, conformance, drones, geofences] = await Promise.all([
            API.getFlightDeclarations().catch(() => []),
            API.getConflicts(ownerId).catch(() => []),
            API.getConformance(ownerId).catch(() => []),
            API.getDrones(ownerId).catch(() => []),
            API.getGeofences().catch(() => [])
        ]);

        const visibleDroneIds = new Set((drones || []).map((drone) => drone.drone_id));
        const scopedDeclarations = owner
            ? filterDeclarationsByOwner(declarations, owner, visibleDroneIds)
            : declarations;
        const scopedConflicts = filterConflictsByVisibleDrones(conflicts, drones, owner);
        const report = buildReport(range, scopedDeclarations, scopedConflicts, conformance, drones, geofences);
        latestReport = report;

        updateStats(report.metrics);
        renderCharts(report);
        renderFleetTable(report);
        renderEventLog(report.events);
    }

    function filterConflictsByVisibleDrones(conflicts, drones, owner) {
        if (!owner) return conflicts;
        const visibleIds = new Set((drones || []).map(drone => drone.drone_id));
        if (!visibleIds.size) return [];
        return (conflicts || []).filter(conflict =>
            visibleIds.has(conflict.drone1_id) || visibleIds.has(conflict.drone2_id)
        );
    }

    function setLoadingState() {
        setText('totalFlights', '--');
        setText('successRate', '--');
        setText('totalDistance', '--');
        setText('totalFlightTime', '--');
        setText('conflictsResolved', '--');

        const fleetTable = document.getElementById('fleetTable');
        if (fleetTable) {
            fleetTable.innerHTML = `
                <tr>
                    <td colspan="5" class="text-muted">Loading fleet metrics...</td>
                </tr>
            `;
        }

        const eventLog = document.getElementById('eventLog');
        if (eventLog) {
            eventLog.innerHTML = `
                <div class="empty-state" style="padding: 24px;">
                    <div class="empty-state-text text-muted">Loading events...</div>
                </div>
            `;
        }
    }

    function buildReport(range, declarations, conflicts, conformance, drones, geofences) {
        const normalized = normalizeDeclarations(declarations || []);
        const filtered = normalized.filter((decl) => isWithinRange(decl.start, range));

        const metrics = buildMetrics(filtered, conflicts || []);
        const chartsData = buildCharts(range, filtered, conflicts || []);
        const fleet = buildFleetMetrics(drones || [], filtered);
        const events = buildEvents(filtered, conflicts || [], conformance || [], geofences || []);

        return {
            range,
            metrics,
            charts: chartsData,
            fleet,
            events
        };
    }

    function buildMetrics(flights, conflicts) {
        const total = flights.length;
        const successful = flights.filter((flight) => SUCCESS_STATES.has(flight.state)).length;
        const successRate = total ? (successful / total) * 100 : 0;
        const distanceM = flights.reduce((sum, flight) => sum + flight.distanceM, 0);
        const durationSec = flights.reduce((sum, flight) => sum + flight.durationSec, 0);

        return {
            totalFlights: total,
            successRate,
            totalDistanceKm: distanceM / 1000,
            totalFlightHours: durationSec / 3600,
            conflictsActive: conflicts.length
        };
    }

    function buildCharts(range, flights, conflicts) {
        return {
            activity: buildActivitySeries(range, flights),
            conflicts: buildConflictSeries(conflicts),
            durations: buildDurationSeries(flights),
            hourly: buildHourlySeries(flights)
        };
    }

    function buildFleetMetrics(drones, flights) {
        const flightMap = new Map();
        flights.forEach((flight) => {
            if (!flight.aircraftId) return;
            const entry = flightMap.get(flight.aircraftId) || { count: 0, distanceM: 0 };
            entry.count += 1;
            entry.distanceM += flight.distanceM;
            flightMap.set(flight.aircraftId, entry);
        });

        return (drones || []).map((drone) => {
            const entry = flightMap.get(drone.drone_id) || { count: 0, distanceM: 0 };
            return {
                id: drone.drone_id,
                flights: entry.count,
                distanceKm: entry.distanceM / 1000,
                lastUpdate: drone.last_update,
                status: drone.status || 'unknown'
            };
        });
    }

    function buildEvents(flights, conflicts, conformance, geofences) {
        const events = [];

        flights.forEach((flight) => {
            const label = getFlightStateLabel(flight.state);
            const description = `${label}: ${flight.name}`;
            const timestamp = flight.start || flight.createdAt || null;
            if (timestamp) {
                events.push({
                    type: 'flight',
                    title: description,
                    subtitle: flight.aircraftId ? `Drone: ${flight.aircraftId}` : 'Drone: Unassigned',
                    timestamp
                });
            }
        });

        conflicts.forEach((conflict) => {
            const timestamp = conflict.timestamp ? new Date(conflict.timestamp * 1000) : null;
            events.push({
                type: 'conflict',
                title: `Conflict ${formatSeverity(conflict.severity)}`,
                subtitle: `${conflict.drone1_id} vs ${conflict.drone2_id}`,
                timestamp: timestamp || new Date()
            });
        });

        conformance.forEach((entry) => {
            if (!entry || entry.status === 'conforming') return;
            const record = entry.record || {};
            const timestamp = parseDate(record.timestamp) || parseDate(entry.last_checked) || new Date();
            const title = entry.status === 'nonconforming' ? 'Conformance alert' : 'Conformance check';
            const subtitle = `${entry.drone_id}: ${record.description || 'Review required'}`;
            events.push({
                type: 'conformance',
                title,
                subtitle,
                timestamp
            });
        });

        geofences.forEach((geofence) => {
            const timestamp = parseDate(geofence.created_at);
            if (!timestamp) return;
            const status = geofence.active === false ? 'Disabled' : 'Active';
            events.push({
                type: 'geofence',
                title: `${status} geofence`,
                subtitle: geofence.name || geofence.id,
                timestamp
            });
        });

        return events
            .filter((event) => event.timestamp)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 8);
    }

    function updateStats(metrics) {
        if (!metrics) return;
        setText('totalFlights', metrics.totalFlights.toString());
        setText('successRate', `${metrics.successRate.toFixed(1)}%`);
        setText('totalDistance', formatDistance(metrics.totalDistanceKm));
        setText('totalFlightTime', `${metrics.totalFlightHours.toFixed(1)} hrs`);
        setText('conflictsResolved', metrics.conflictsActive.toString());
    }

    function renderCharts(report) {
        if (!report || !report.charts) return;

        renderActivityChart(report.charts.activity);
        renderConflictChart(report.charts.conflicts);
        renderDurationChart(report.charts.durations);
        renderHourlyChart(report.charts.hourly);
    }

    function renderActivityChart(series) {
        const ctx = document.getElementById('flightActivityChart');
        if (!ctx) return;
        destroyChart('activity');
        charts.activity = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: series.labels,
                datasets: [
                    {
                        label: 'Completed',
                        data: series.completed,
                        backgroundColor: 'rgba(16, 185, 129, 0.8)',
                        borderRadius: 4
                    },
                    {
                        label: 'In Progress',
                        data: series.active,
                        backgroundColor: 'rgba(251, 191, 36, 0.8)',
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { boxWidth: 12, padding: 15 }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: '#1e293b' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    function renderConflictChart(series) {
        const ctx = document.getElementById('conflictChart');
        if (!ctx) return;
        destroyChart('conflicts');
        charts.conflicts = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Critical', 'Warning', 'Info'],
                datasets: [
                    {
                        data: [series.critical, series.warning, series.info],
                        backgroundColor: [
                            'rgba(239, 68, 68, 0.9)',
                            'rgba(251, 191, 36, 0.9)',
                            'rgba(148, 163, 184, 0.9)'
                        ],
                        borderColor: '#0f172a',
                        borderWidth: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { boxWidth: 10 }
                    }
                }
            }
        });
    }

    function renderDurationChart(series) {
        const ctx = document.getElementById('durationChart');
        if (!ctx) return;
        destroyChart('durations');
        charts.durations = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: series.labels,
                datasets: [
                    {
                        label: 'Flights',
                        data: series.counts,
                        backgroundColor: 'rgba(59, 130, 246, 0.75)',
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: '#1e293b' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    function renderHourlyChart(series) {
        const ctx = document.getElementById('hourlyChart');
        if (!ctx) return;
        destroyChart('hourly');
        charts.hourly = new Chart(ctx, {
            type: 'line',
            data: {
                labels: series.labels,
                datasets: [
                    {
                        label: 'Flights',
                        data: series.counts,
                        borderColor: 'rgba(16, 185, 129, 0.9)',
                        backgroundColor: 'rgba(16, 185, 129, 0.15)',
                        fill: true,
                        tension: 0.3
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: '#1e293b' }
                    },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    function renderFleetTable(report) {
        const table = document.getElementById('fleetTable');
        if (!table) return;

        if (!report.fleet || report.fleet.length === 0) {
            table.innerHTML = `
                <tr>
                    <td colspan="5" class="text-muted">No drones reporting in this range.</td>
                </tr>
            `;
            return;
        }

        table.innerHTML = report.fleet.map((drone) => {
            const status = getDroneStatus(drone.status);
            return `
                <tr>
                    <td>${drone.id}</td>
                    <td>${drone.flights}</td>
                    <td>${formatDistance(drone.distanceKm)}</td>
                    <td>${formatUptime(drone.lastUpdate, drone.status)}</td>
                    <td><span class="status-badge ${status.className}">${status.label}</span></td>
                </tr>
            `;
        }).join('');
    }

    function renderEventLog(events) {
        const container = document.getElementById('eventLog');
        if (!container) return;

        if (!events || events.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding: 24px;">
                    <div class="empty-state-text text-muted">No events in this range.</div>
                </div>
            `;
            return;
        }

        container.innerHTML = events.map((event) => {
            return `
                <div class="list-item" style="padding: 8px 12px;">
                    <div class="list-item-content">
                        <div class="list-item-title">${event.title}</div>
                        <div class="list-item-subtitle">${event.subtitle}</div>
                    </div>
                    <span class="text-muted" style="font-size: 11px;">${formatRelativeTime(event.timestamp)}</span>
                </div>
            `;
        }).join('');
    }

    function exportReport() {
        if (!latestReport) {
            alert('No analytics data available yet.');
            return;
        }

        const filename = `analytics-report-${new Date().toISOString().slice(0, 10)}.json`;
        const payload = {
            generated_at: new Date().toISOString(),
            range: {
                start: latestReport.range.start.toISOString(),
                end: latestReport.range.end.toISOString(),
                label: latestReport.range.label
            },
            metrics: latestReport.metrics,
            events: latestReport.events
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }

    function buildActivitySeries(range, flights) {
        const labels = [];
        const completed = [];
        const active = [];

        let cursor = new Date(range.start);
        while (cursor <= range.end) {
            labels.push(formatDateLabel(cursor, range.label));
            completed.push(0);
            active.push(0);
            cursor = new Date(cursor.getTime() + DAY_MS);
        }

        flights.forEach((flight) => {
            if (!flight.start) return;
            const dayIndex = Math.floor((stripTime(flight.start) - stripTime(range.start)) / DAY_MS);
            if (dayIndex < 0 || dayIndex >= labels.length) return;
            if (ACTIVE_STATES.has(flight.state)) {
                active[dayIndex] += 1;
            } else if (COMPLETED_STATES.has(flight.state)) {
                completed[dayIndex] += 1;
            }
        });

        return { labels, completed, active };
    }

    function buildConflictSeries(conflicts) {
        const counts = { critical: 0, warning: 0, info: 0 };
        conflicts.forEach((conflict) => {
            switch (String(conflict.severity || '').toLowerCase()) {
                case 'critical':
                    counts.critical += 1;
                    break;
                case 'warning':
                    counts.warning += 1;
                    break;
                default:
                    counts.info += 1;
                    break;
            }
        });
        return counts;
    }

    function buildDurationSeries(flights) {
        const labels = ['0-5m', '5-10m', '10-20m', '20-30m', '30-60m', '60m+'];
        const buckets = [0, 0, 0, 0, 0, 0];

        flights.forEach((flight) => {
            const minutes = flight.durationSec / 60;
            if (minutes <= 5) buckets[0] += 1;
            else if (minutes <= 10) buckets[1] += 1;
            else if (minutes <= 20) buckets[2] += 1;
            else if (minutes <= 30) buckets[3] += 1;
            else if (minutes <= 60) buckets[4] += 1;
            else buckets[5] += 1;
        });

        return { labels, counts: buckets };
    }

    function buildHourlySeries(flights) {
        const labels = Array.from({ length: 24 }, (_, hour) => `${hour}:00`);
        const counts = Array.from({ length: 24 }, () => 0);

        flights.forEach((flight) => {
            if (!flight.start) return;
            const hour = flight.start.getHours();
            counts[hour] += 1;
        });

        return { labels, counts };
    }

    function normalizeDeclarations(declarations) {
        return (declarations || []).map((decl) => {
            const state = Number.isFinite(Number(decl.state))
                ? Number(decl.state)
                : Number(decl.flight_state || 0);
            const start = parseDate(decl.start_datetime || decl.start_time || decl.start_date || decl.created_at);
            const end = parseDate(decl.end_datetime || decl.end_time || decl.end_date || decl.updated_at);
            const durationSec = start && end ? Math.max(0, (end - start) / 1000) : 0;
            const geojson = extractGeoJson(decl);
            const distanceM = geojson ? computeGeoJsonDistance(geojson) : 0;
            const name = decl.originating_party || decl.purpose || decl.flight_id || decl.id || 'Mission';
            return {
                id: decl.id || decl.flight_id || null,
                aircraftId: decl.aircraft_id || decl.aircraft || null,
                state,
                name,
                start,
                end,
                createdAt: parseDate(decl.created_at),
                durationSec,
                distanceM
            };
        });
    }

    function extractGeoJson(decl) {
        const raw = decl.flight_declaration_geojson
            || decl.flight_declaration_geo_json
            || decl.flight_declaration_raw_geojson
            || null;

        if (!raw) return null;
        if (typeof raw === 'object') return raw;
        try {
            return JSON.parse(raw);
        } catch (error) {
            return null;
        }
    }

    function computeGeoJsonDistance(geojson) {
        if (!geojson) return 0;
        const features = geojson.features || [];
        let distance = 0;
        features.forEach((feature) => {
            if (!feature || !feature.geometry) return;
            distance += geometryDistance(feature.geometry);
        });
        return distance;
    }

    function geometryDistance(geometry) {
        if (!geometry || !geometry.type) return 0;
        const type = geometry.type;
        switch (type) {
            case 'LineString':
                return lineDistance(geometry.coordinates);
            case 'MultiLineString':
                return geometry.coordinates.reduce((sum, coords) => sum + lineDistance(coords), 0);
            case 'Polygon':
                return geometry.coordinates.reduce((sum, ring) => sum + lineDistance(ring), 0);
            case 'MultiPolygon':
                return geometry.coordinates.reduce((sum, polygon) => {
                    return sum + polygon.reduce((inner, ring) => inner + lineDistance(ring), 0);
                }, 0);
            default:
                return 0;
        }
    }

    function lineDistance(coords) {
        if (!Array.isArray(coords) || coords.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < coords.length; i += 1) {
            const [lon1, lat1] = coords[i - 1] || [];
            const [lon2, lat2] = coords[i] || [];
            if (!isFinite(lat1) || !isFinite(lon1) || !isFinite(lat2) || !isFinite(lon2)) continue;
            total += haversine(lat1, lon1, lat2, lon2);
        }
        return total;
    }

    function haversine(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const phi1 = lat1 * Math.PI / 180;
        const phi2 = lat2 * Math.PI / 180;
        const dphi = (lat2 - lat1) * Math.PI / 180;
        const dlambda = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(dphi / 2) * Math.sin(dphi / 2)
            + Math.cos(phi1) * Math.cos(phi2)
            * Math.sin(dlambda / 2) * Math.sin(dlambda / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function parseDate(value) {
        if (!value) return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        return date;
    }

    function getDateRange() {
        const selector = document.getElementById('dateRange');
        const value = selector ? selector.value : 'week';
        const end = new Date();
        let start = new Date(end);

        if (value === 'today') {
            start = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        } else if (value === 'month') {
            start = new Date(end.getTime() - 29 * DAY_MS);
        } else {
            start = new Date(end.getTime() - 6 * DAY_MS);
        }

        return { start, end, label: value };
    }

    function isWithinRange(date, range) {
        if (!date) return false;
        return date >= range.start && date <= range.end;
    }

    function stripTime(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    function formatDateLabel(date, rangeLabel) {
        if (rangeLabel === 'today') {
            return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        }
        if (rangeLabel === 'month') {
            return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        }
        return date.toLocaleDateString(undefined, { weekday: 'short' });
    }

    function formatDistance(distanceKm) {
        if (!Number.isFinite(distanceKm)) return '--';
        if (distanceKm < 1) return `${(distanceKm * 1000).toFixed(0)} m`;
        return `${distanceKm.toFixed(1)} km`;
    }

    function formatUptime(lastUpdate, status) {
        const statusText = String(status || '').toLowerCase();
        if (!lastUpdate) {
            return statusText === 'inactive' ? '0%' : '--';
        }
        const last = parseDate(lastUpdate);
        if (!last) return '--';
        const seconds = (Date.now() - last.getTime()) / 1000;
        if (statusText === 'lost') return '0%';
        if (seconds < 30) return '99%';
        if (seconds < 120) return '95%';
        if (seconds < 300) return '90%';
        return '80%';
    }

    function getDroneStatus(status) {
        switch (String(status || '').toLowerCase()) {
            case 'active':
                return { label: 'Healthy', className: 'online' };
            case 'holding':
                return { label: 'Holding', className: 'flying' };
            case 'inactive':
                return { label: 'Inactive', className: 'offline' };
            case 'lost':
                return { label: 'Lost', className: 'offline' };
            default:
                return { label: 'Unknown', className: 'pending' };
        }
    }

    function formatRelativeTime(date) {
        if (!date) return '--';
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    function getFlightStateLabel(state) {
        switch (state) {
            case 2:
                return 'Mission active';
            case 3:
                return 'Nonconforming';
            case 4:
                return 'Contingent';
            case 5:
                return 'Mission completed';
            case 6:
                return 'Mission withdrawn';
            case 7:
                return 'Mission cancelled';
            case 8:
                return 'Mission rejected';
            case 1:
                return 'Mission accepted';
            default:
                return 'Mission submitted';
        }
    }

    function formatSeverity(severity) {
        const normalized = String(severity || '').toLowerCase();
        if (!normalized) return 'Info';
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    function destroyChart(key) {
        if (charts[key]) {
            charts[key].destroy();
            delete charts[key];
        }
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    window.exportReport = exportReport;
})();
