/**
 * Conflicts Page Logic
 */

(function () {
    'use strict';

    const REFRESH_INTERVAL = 4000;
    const MAX_HISTORY = 20;

    let activeConflicts = [];
    let conflictStarts = new Map();
    let resolvedHistory = [];
    let selectedKey = null;

    function getOwnerId() {
        const user = window.APP_USER;
        if (!user || user.role === 'authority') return null;
        return user.id || null;
    }

    function buildConflictKey(conflict) {
        const ids = [conflict.drone1_id, conflict.drone2_id].filter(Boolean).sort();
        return ids.join('::');
    }

    function getSeverityRank(severity) {
        switch (String(severity || '').toLowerCase()) {
            case 'critical':
                return 3;
            case 'warning':
                return 2;
            default:
                return 1;
        }
    }

    function getSeverityClass(severity) {
        switch (String(severity || '').toLowerCase()) {
            case 'critical':
                return 'fail';
            case 'warning':
                return 'warn';
            default:
                return 'pending';
        }
    }

    function formatSeverity(severity) {
        const label = String(severity || 'info').toLowerCase();
        return label.charAt(0).toUpperCase() + label.slice(1);
    }

    function formatDistance(distance) {
        if (!Number.isFinite(distance)) return '--';
        return `${distance.toFixed(0)}m`;
    }

    function formatSeconds(seconds) {
        if (!Number.isFinite(seconds)) return '--';
        if (seconds < 60) return `${seconds.toFixed(1)}s`;
        const mins = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${mins}m ${secs}s`;
    }

    function isSameDay(a, b) {
        const dateA = new Date(a);
        const dateB = new Date(b);
        return dateA.getFullYear() === dateB.getFullYear()
            && dateA.getMonth() === dateB.getMonth()
            && dateA.getDate() === dateB.getDate();
    }

    function recordResolvedConflicts(previousConflicts, nextKeys) {
        const now = Date.now();
        const prevByKey = new Map(previousConflicts.map(conflict => [buildConflictKey(conflict), conflict]));

        for (const [key, startTime] of conflictStarts.entries()) {
            if (nextKeys.has(key)) continue;
            const conflict = prevByKey.get(key);
            if (conflict) {
                resolvedHistory.unshift({
                    key,
                    conflict,
                    resolvedAt: now,
                    durationMs: Math.max(0, now - startTime)
                });
            }
            conflictStarts.delete(key);
        }

        if (resolvedHistory.length > MAX_HISTORY) {
            resolvedHistory = resolvedHistory.slice(0, MAX_HISTORY);
        }
    }

    async function loadConflicts() {
        try {
            const conflicts = await API.getConflicts(getOwnerId());
            updateConflicts(conflicts || []);
        } catch (error) {
            console.error('[Conflicts] Load failed:', error);
        }
    }

    function updateConflicts(conflicts) {
        const now = Date.now();
        const nextKeys = new Set();

        conflicts.forEach(conflict => {
            const key = buildConflictKey(conflict);
            nextKeys.add(key);
            if (!conflictStarts.has(key)) {
                conflictStarts.set(key, now);
            }
        });

        recordResolvedConflicts(activeConflicts, nextKeys);
        activeConflicts = conflicts;

        if (selectedKey && !nextKeys.has(selectedKey)) {
            selectedKey = null;
        }

        renderAlert();
        renderStats();
        renderConflictList();
        renderConflictDetail();
        renderHistory();
    }

    function renderAlert() {
        const alertEl = document.getElementById('conflictAlert');
        const alertText = document.getElementById('conflictAlertText');
        if (!alertEl || !alertText) return;

        if (!activeConflicts.length) {
            alertEl.style.display = 'none';
            return;
        }

        alertEl.style.display = 'flex';
        alertText.textContent = `${activeConflicts.length} conflict(s) require attention`;
    }

    function renderStats() {
        const criticalCount = activeConflicts.filter(c => String(c.severity).toLowerCase() === 'critical').length;
        const warningCount = activeConflicts.filter(c => String(c.severity).toLowerCase() === 'warning').length;
        const now = Date.now();

        const resolvedToday = resolvedHistory.filter(entry => isSameDay(entry.resolvedAt, now));
        const avgMs = resolvedToday.length
            ? resolvedToday.reduce((sum, entry) => sum + entry.durationMs, 0) / resolvedToday.length
            : null;

        const criticalEl = document.getElementById('criticalConflicts');
        const warningEl = document.getElementById('warningConflicts');
        const resolvedEl = document.getElementById('resolvedToday');
        const avgEl = document.getElementById('avgResolutionTime');

        if (criticalEl) criticalEl.textContent = criticalCount.toString();
        if (warningEl) warningEl.textContent = warningCount.toString();
        if (resolvedEl) resolvedEl.textContent = resolvedToday.length.toString();
        if (avgEl) avgEl.textContent = avgMs ? formatSeconds(avgMs / 1000) : '--';
    }

    function renderConflictList() {
        const container = document.getElementById('conflictList');
        if (!container) return;

        if (!activeConflicts.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">No active conflicts</div>
                    <p class="text-muted mt-sm">All airspace is clear</p>
                </div>
            `;
            return;
        }

        const sorted = [...activeConflicts].sort((a, b) => {
            const rank = getSeverityRank(b.severity) - getSeverityRank(a.severity);
            if (rank !== 0) return rank;
            return (a.distance_m || 0) - (b.distance_m || 0);
        });

        container.innerHTML = sorted.map(conflict => {
            const key = buildConflictKey(conflict);
            const severityClass = getSeverityClass(conflict.severity);
            const severityLabel = formatSeverity(conflict.severity);
            const distance = formatDistance(conflict.distance_m);
            const timeToClosest = formatSeconds(conflict.time_to_closest);
            const isSelected = selectedKey === key ? 'selected' : '';

            return `
                <div class="list-item ${isSelected}" data-conflict-key="${key}">
                    <span class="status-dot conflict"></span>
                    <div class="list-item-content">
                        <div class="list-item-title">${conflict.drone1_id} vs ${conflict.drone2_id}</div>
                        <div class="list-item-subtitle">Separation: ${distance} • TCA: ${timeToClosest}</div>
                    </div>
                    <span class="status-badge ${severityClass}">${severityLabel}</span>
                </div>
            `;
        }).join('');
    }

    function renderConflictDetail() {
        const detail = document.getElementById('conflictDetail');
        if (!detail) return;

        const conflict = activeConflicts.find(c => buildConflictKey(c) === selectedKey);
        if (!conflict) {
            detail.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">Select a conflict to view details</div>
                </div>
            `;
            return;
        }

        const severityClass = getSeverityClass(conflict.severity);
        const severityLabel = formatSeverity(conflict.severity);
        const distance = formatDistance(conflict.distance_m);
        const timeToClosest = formatSeconds(conflict.time_to_closest);
        const closestDistance = formatDistance(conflict.closest_distance_m);
        const cpaText = `${conflict.cpa_lat.toFixed(5)}, ${conflict.cpa_lon.toFixed(5)} @ ${conflict.cpa_altitude_m.toFixed(0)}m`;

        detail.innerHTML = `
            <div class="mb-md">
                <div class="detail-row">
                    <span class="detail-label">Severity</span>
                    <span class="status-badge ${severityClass}">${severityLabel}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Drones</span>
                    <span class="detail-value">${conflict.drone1_id} / ${conflict.drone2_id}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Current Separation</span>
                    <span class="detail-value">${distance}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Closest Distance</span>
                    <span class="detail-value">${closestDistance}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Time To Closest</span>
                    <span class="detail-value">${timeToClosest}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">CPA Location</span>
                    <span class="detail-value">${cpaText}</span>
                </div>
            </div>
            <div class="flex gap-sm">
                <button class="btn btn-warning btn-sm" data-action="hold" data-drone="${conflict.drone1_id}">
                    HOLD ${conflict.drone1_id}
                </button>
                <button class="btn btn-warning btn-sm" data-action="hold" data-drone="${conflict.drone2_id}">
                    HOLD ${conflict.drone2_id}
                </button>
                <button class="btn btn-success btn-sm" data-action="resume" data-drone="${conflict.drone1_id}">
                    RESUME ${conflict.drone1_id}
                </button>
                <button class="btn btn-success btn-sm" data-action="resume" data-drone="${conflict.drone2_id}">
                    RESUME ${conflict.drone2_id}
                </button>
            </div>
        `;
    }

    function renderHistory() {
        const tbody = document.querySelector('#conflictHistory tbody');
        if (!tbody) return;

        if (!resolvedHistory.length) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="text-muted">No conflicts resolved yet.</td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = resolvedHistory.slice(0, 8).map(entry => {
            const conflict = entry.conflict || {};
            const resolvedAt = new Date(entry.resolvedAt).toLocaleTimeString();
            const severityClass = getSeverityClass(conflict.severity);
            const severityLabel = formatSeverity(conflict.severity);
            const duration = formatSeconds(entry.durationMs / 1000);
            return `
                <tr>
                    <td>${resolvedAt}</td>
                    <td>${conflict.drone1_id || '--'} - ${conflict.drone2_id || '--'}</td>
                    <td><span class="status-badge ${severityClass}">${severityLabel}</span></td>
                    <td>Auto</td>
                    <td>${duration}</td>
                </tr>
            `;
        }).join('');
    }

    function handleConflictListClick(event) {
        const item = event.target.closest('[data-conflict-key]');
        if (!item) return;
        selectedKey = item.dataset.conflictKey;
        renderConflictList();
        renderConflictDetail();
    }

    async function handleDetailAction(event) {
        const button = event.target.closest('button[data-action]');
        if (!button) return;

        const droneId = button.dataset.drone;
        const action = button.dataset.action;
        if (!droneId || !action) return;

        try {
            if (action === 'hold') {
                await API.holdDrone(droneId, 30);
            } else if (action === 'resume') {
                await API.resumeDrone(droneId);
            }
            loadConflicts();
        } catch (error) {
            console.error('[Conflicts] Command failed:', error);
            alert(`Command failed: ${error.message}`);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        loadConflicts();
        setInterval(loadConflicts, REFRESH_INTERVAL);

        const refreshBtn = document.getElementById('refreshConflicts');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', loadConflicts);
        }

        const list = document.getElementById('conflictList');
        if (list) {
            list.addEventListener('click', handleConflictListClick);
        }

        const detail = document.getElementById('conflictDetail');
        if (detail) {
            detail.addEventListener('click', handleDetailAction);
        }
    });
})();
