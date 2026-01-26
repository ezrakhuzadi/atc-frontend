/**
 * Missions Page Logic
 */

(function () {
    'use strict';

    const REFRESH_INTERVAL = 5000;

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

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDelayMs(delayMs) {
        if (!Number.isFinite(delayMs)) return null;
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

    function getDeclarationId(mission) {
        const id = mission?.id || mission?.pk || null;
        return id !== null && id !== undefined ? String(id) : null;
    }

    function buildPlanIndex(plans) {
        const byDroneId = new Map();
        const byPlanId = new Map();
        const byDeclarationId = new Map();

        (plans || []).forEach((plan) => {
            if (!plan) return;
            if (plan.flight_id) {
                const existing = byPlanId.get(plan.flight_id);
                byPlanId.set(plan.flight_id, pickLatestPlan(existing, plan));
            }
            const declarationId = plan?.metadata?.blender_declaration_id;
            if (declarationId) {
                const key = String(declarationId);
                const existing = byDeclarationId.get(key);
                byDeclarationId.set(key, pickLatestPlan(existing, plan));
            }
            if (plan.drone_id) {
                const existing = byDroneId.get(plan.drone_id);
                byDroneId.set(plan.drone_id, pickLatestPlan(existing, plan));
            }
        });

        return { byDroneId, byPlanId, byDeclarationId };
    }

    function getPlanForMission(mission, planIndex) {
        if (!mission || !planIndex) return null;
        const planId = utils.getAtcPlanId(mission);
        if (planId && planIndex.byPlanId.has(planId)) {
            return planIndex.byPlanId.get(planId);
        }

        const declarationId = getDeclarationId(mission);
        if (declarationId && planIndex.byDeclarationId.has(declarationId)) {
            return planIndex.byDeclarationId.get(declarationId);
        }

        const droneId = mission.aircraft_id;
        if (droneId && planIndex.byDroneId.has(droneId)) {
            return planIndex.byDroneId.get(droneId);
        }

        return null;
    }

    function matchesOwner(mission, owner, droneIds) {
        if (!owner) return true;
        const emailMatch = owner.email
            && utils.normalizeEmail(mission?.submitted_by) === owner.email;
        const droneId = mission?.aircraft_id || '';
        const droneMatch = droneId && droneIds.has(droneId);
        return emailMatch || droneMatch;
    }

    /**
     * Load and display missions from Flight Blender
     */
    async function loadMissions() {
        try {
            const owner = utils.getOwnerContext();
            const ownerId = owner?.id || null;
            const [declarations, conformance, plans, drones] = await Promise.all([
                API.getFlightDeclarations(),
                API.getConformance(ownerId).catch(() => []),
                API.getFlightPlans().catch(() => []),
                owner ? API.getDrones(ownerId).catch(() => []) : Promise.resolve([])
            ]);
            const visibleDroneIds = new Set((drones || []).map((drone) => drone.drone_id));
            const scopedDeclarations = owner
                ? (declarations || []).filter((decl) => matchesOwner(decl, owner, visibleDroneIds))
                : declarations;
            const scopedPlans = owner
                ? (plans || []).filter((plan) => {
                    if (plan?.owner_id && plan.owner_id === owner.id) return true;
                    return visibleDroneIds.has(plan?.drone_id);
                })
                : plans;
            const conformanceMap = new Map((conformance || []).map(entry => [entry.drone_id, entry]));
            const planIndex = buildPlanIndex(scopedPlans || []);

            const activeStates = new Set([2, 3, 4]);
            const completedStates = new Set([5, 6, 7, 8]);

            const active = scopedDeclarations.filter(decl => activeStates.has(decl.state));
            const completed = scopedDeclarations.filter(decl => completedStates.has(decl.state));
            const pending = scopedDeclarations.filter(decl => !activeStates.has(decl.state) && !completedStates.has(decl.state));

            renderMissionSection('activeMissions', active, 'active', conformanceMap, planIndex);
            renderMissionSection('pendingMissions', pending, 'pending', conformanceMap, planIndex);
            renderMissionSection('completedMissions', completed, 'completed', conformanceMap, planIndex);
        } catch (error) {
            console.error('[Missions] Load failed:', error);
        }
    }

    function renderMissionSection(containerId, missions, type, conformanceMap, planIndex) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!missions || missions.length === 0) {
            const emptyMessages = {
                active: 'No active missions',
                pending: 'No pending missions',
                completed: 'No completed missions today'
            };
            container.innerHTML = `
                <div class="empty-state" style="padding: 24px;">
                    <div class="empty-state-text text-muted">${emptyMessages[type]}</div>
                </div>
            `;
            return;
        }

        container.innerHTML = missions.map(mission => {
            const missionId = mission.id || mission.pk || '';
            const missionIdText = missionId ? String(missionId) : '';
            const missionNameRaw = mission.originating_party
                || (missionIdText ? `Mission ${missionIdText.slice(0, 8)}` : 'Mission');
            const missionName = escapeHtml(missionNameRaw);
            const stateLabel = escapeHtml(STATE_LABELS[mission.state] || 'Unknown');
            const timeRange = escapeHtml(
                `${utils.formatDateTime(mission.start_datetime, 'Unknown')} - ${utils.formatDateTime(mission.end_datetime, 'Unknown')}`
            );
            const aircraftId = escapeHtml(mission.aircraft_id || 'Unassigned');
            const compliance = getComplianceSummary(mission);
            const complianceLine = compliance
                ? `<div class="list-item-subtitle"><span class="status-badge ${compliance.className}">Compliance ${escapeHtml(compliance.label)}</span></div>`
                : '';
            const conformance = getConformanceSummary(mission, conformanceMap);
            const conformanceLine = conformance
                ? `<div class="list-item-subtitle"><span class="status-badge ${conformance.className}">Conformance ${escapeHtml(conformance.label)}</span></div>`
                : '';
            const conformanceDetail = conformance?.detail
                ? `<div class="list-item-subtitle">${escapeHtml(conformance.detail)}</div>`
                : '';
            const plan = getPlanForMission(mission, planIndex);
            const planSummary = getPlanSummary(plan);
            const requestedAtc = plan?.metadata?.requested_departure_time || mission.start_datetime || '';
            const requestedMs = Date.parse(requestedAtc || '');
            const scheduledMs = Date.parse(plan?.departure_time || '');
            const delayMs = Number.isFinite(requestedMs) && Number.isFinite(scheduledMs)
                ? scheduledMs - requestedMs
                : NaN;
            const delayLabel = formatDelayMs(delayMs);
            const delayLine = planSummary && delayLabel
                ? `<div class="list-item-subtitle"><span class="status-badge warn">ATC Delay ${escapeHtml(delayLabel)}</span></div>`
                : '';
            const planLine = planSummary
                ? `<div class="list-item-subtitle"><span class="status-badge ${planSummary.className}">ATC Plan ${escapeHtml(planSummary.label)}</span></div>`
                : mission.aircraft_id
                    ? `<div class="list-item-subtitle"><span class="status-badge warn">ATC Plan Not Submitted</span></div>`
                    : '';
            const planMeta = plan?.metadata || null;
            const complianceBadge = planMeta?.faa_compliant === true
                ? `<span class="status-badge pass">Planner Compliant</span>`
                : planMeta?.faa_compliant === false
                    ? `<span class="status-badge fail">Planner Noncompliant</span>`
                    : '';
            const plannerComplianceLine = complianceBadge
                ? `<div class="list-item-subtitle">${complianceBadge}</div>`
                : '';
            const detailsHref = missionIdText ? `/control/missions/${encodeURIComponent(missionIdText)}` : '';
            const detailsButton = missionIdText
                ? `<button class="btn btn-ghost btn-sm" onclick="window.location.href='${detailsHref}'">Details</button>`
                : '';
            return `
                <div class="list-item">
                    <span class="status-dot ${type === 'active' ? 'flying' : 'idle'}"></span>
                    <div class="list-item-content">
                        <div class="list-item-title">${missionName}</div>
                        <div class="list-item-subtitle">Drone: ${aircraftId}</div>
                        <div class="list-item-subtitle">State: ${stateLabel}</div>
                        <div class="list-item-subtitle">${timeRange}</div>
                        ${complianceLine}
                        ${conformanceLine}
                        ${conformanceDetail}
                        ${planLine}
                        ${delayLine}
                        ${plannerComplianceLine}
                    </div>
                    <div class="list-item-actions">
                        ${detailsButton}
                        ${type === 'active' ? `
                            <button class="btn btn-ghost btn-sm" onclick="window.location.href='/control/map?track=${encodeURIComponent(mission.aircraft_id || '')}'">
                                Track
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    function getPlanSummary(plan) {
        if (!plan) return null;
        const status = String(plan.status || '').toLowerCase();
        const label = PLAN_STATUS_LABELS[status] || 'Unknown';
        return { label, className: getPlanClass(status) };
    }

    function getPlanClass(status) {
        switch (status) {
            case 'active':
                return 'flying';
            case 'completed':
                return 'pass';
            case 'reserved':
            case 'approved':
                return 'pending';
            case 'rejected':
            case 'cancelled':
                return 'fail';
            case 'pending':
            default:
                return 'warn';
        }
    }

    function getComplianceSummary(mission) {
        const compliance = utils.extractCompliance(mission);
        if (!compliance) return null;
        const status = compliance.overall_status || 'pending';
        const className = ['pass', 'warn', 'fail', 'pending'].includes(status) ? status : 'pending';
        const label = status === 'warn' ? 'Warn' : status.charAt(0).toUpperCase() + status.slice(1);
        return { className, label };
    }

    function getConformanceSummary(mission, conformanceMap) {
        if (!conformanceMap || !mission?.aircraft_id) return null;
        const entry = conformanceMap.get(mission.aircraft_id);
        if (!entry) {
            return { className: 'warn', label: 'Unknown' };
        }
        const status = entry.status || 'unknown';
        const className = utils.getConformanceClass(status);
        const label = status === 'nonconforming' ? 'Nonconforming' : status === 'conforming' ? 'Conforming' : 'Unknown';
        const record = entry.record;
        const detail = status === 'nonconforming' && record
            ? `${record.conformance_state_code || 'NC'}: ${record.description || 'Conformance issue'}`
            : null;
        return { className, label, detail };
    }

    async function abortMission(droneId) {
        if (!confirm(`Abort mission and hold ${droneId}?`)) return;

        try {
            await API.holdDrone(droneId, 999);
            alert(`Abort command sent to ${droneId}`);
            loadMissions();
        } catch (error) {
            alert(`Failed to abort: ${error.message}`);
        }
    }

    function planNewMission() {
        window.location.href = '/control/missions/plan';
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', () => {
        loadMissions();
        setInterval(loadMissions, REFRESH_INTERVAL);

        // New mission button
        const newMissionBtn = document.getElementById('newMissionBtn');
        if (newMissionBtn) {
            newMissionBtn.addEventListener('click', planNewMission);
        }

        // Refresh button
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', loadMissions);
        }
    });

    // Export for global access
    window.Missions = {
        abort: abortMission,
        plan: planNewMission
    };
})();
