/**
 * API Client - ATC Server Interface
 * Wrapper for all ATC-Drone server communication
 */

const API = (function () {
    'use strict';

    // Configuration
    const ATC_SERVER_URL = window.__ATC_API_BASE__ || 'http://localhost:3000';

    // State
    let lastUpdate = null;
    const ownerCache = new Map();
    let ownerCacheUpdatedAt = 0;
    const STATUS_ALIASES = new Map([
        ['inflight', 'active'],
        ['rerouting', 'active'],
        ['ready', 'inactive'],
        ['registered', 'inactive']
    ]);

    function getEffectiveOwnerId(ownerId = null) {
        if (ownerId !== null && ownerId !== undefined) return ownerId;
        if (typeof window === 'undefined') return null;
        const user = window.APP_USER;
        if (!user || user.role === 'authority') return null;
        return user.id || null;
    }

    function updateOwnerCache(drones) {
        if (!Array.isArray(drones)) return;
        drones.forEach(drone => {
            if (!drone || !drone.drone_id) return;
            ownerCache.set(drone.drone_id, drone.owner_id || null);
        });
        ownerCacheUpdatedAt = Date.now();
    }

    async function fetchDrones(ownerId = null) {
        const effectiveOwnerId = getEffectiveOwnerId(ownerId);
        const url = effectiveOwnerId ? `/v1/drones?owner_id=${encodeURIComponent(effectiveOwnerId)}` : '/v1/drones';
        const drones = await request(url);
        updateOwnerCache(drones);
        return drones;
    }

    async function resolveOwnerId(droneId, ownerId = null) {
        const effectiveOwnerId = getEffectiveOwnerId(ownerId);
        if (effectiveOwnerId) return effectiveOwnerId;
        if (!droneId) return null;
        if (ownerCache.has(droneId)) return ownerCache.get(droneId) || null;
        if (ownerCacheUpdatedAt && Date.now() - ownerCacheUpdatedAt < 5000) {
            return ownerCache.get(droneId) || null;
        }
        try {
            await fetchDrones();
        } catch (error) {
            console.warn('[API] Unable to refresh drone cache:', error);
        }
        return ownerCache.get(droneId) || null;
    }

    function normalizeDroneStatus(status) {
        if (!status) return 'unknown';
        const value = String(status).trim().toLowerCase();
        return STATUS_ALIASES.get(value) || value;
    }

    function isFlyingStatus(status) {
        const normalized = normalizeDroneStatus(status);
        return normalized === 'active' || normalized === 'holding';
    }

    function isOnlineStatus(status) {
        const normalized = normalizeDroneStatus(status);
        return normalized !== 'lost' && normalized !== 'unknown';
    }

    function getStatusClass(status) {
        const normalized = normalizeDroneStatus(status);
        switch (normalized) {
            case 'active':
            case 'holding':
                return 'flying';
            case 'inactive':
                return 'online';
            case 'lost':
                return 'offline';
            default:
                return 'online';
        }
    }

    function getStatusLabel(status) {
        const normalized = normalizeDroneStatus(status);
        switch (normalized) {
            case 'active':
                return 'Active';
            case 'holding':
                return 'Holding';
            case 'inactive':
                return 'Inactive';
            case 'lost':
                return 'Lost';
            default:
                return status ? String(status) : 'Unknown';
        }
    }

    if (typeof window !== 'undefined') {
        window.ATCStatus = {
            normalizeDroneStatus,
            isFlyingStatus,
            isOnlineStatus,
            getStatusClass,
            getStatusLabel
        };
    }

    /**
     * Make an API request
     */
    async function request(endpoint, options = {}) {
        const url = `${ATC_SERVER_URL}${endpoint}`;

        try {
            const response = await fetch(url, {
                credentials: 'same-origin',
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            lastUpdate = new Date();
            updateLastUpdateUI();

            return await response.json();
        } catch (error) {
            console.error(`[API] ${endpoint} failed:`, error);
            throw error;
        }
    }

    async function requestLocal(endpoint, options = {}) {
        try {
            const response = await fetch(endpoint, {
                credentials: 'same-origin',
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error: ${response.status} ${errorText}`);
            }

            lastUpdate = new Date();
            updateLastUpdateUI();

            return await response.json();
        } catch (error) {
            console.error(`[API] ${endpoint} failed:`, error);
            throw error;
        }
    }

    /**
     * Update status bar timestamp
     */
    function updateLastUpdateUI() {
        const el = document.getElementById('lastUpdateTime');
        if (el && lastUpdate) {
            const seconds = Math.floor((Date.now() - lastUpdate.getTime()) / 1000);
            el.textContent = seconds < 5 ? 'just now' : `${seconds}s ago`;
        }
    }

    // Update timestamp every second
    setInterval(updateLastUpdateUI, 1000);

    // ========================================
    // API Methods
    // ========================================

    return {
        // Drones - optionally filter by owner
        getDrones: (ownerId = null) => fetchDrones(ownerId),
        getDrone: (id) => request(`/v1/drones/${id}`),
        registerDrone: async (droneId = null, ownerId = null) => {
            const response = await request('/v1/drones/register', {
                method: 'POST',
                body: JSON.stringify({
                    drone_id: droneId || undefined,
                    owner_id: ownerId || undefined
                })
            });
            if (response && response.drone_id) {
                const effectiveOwnerId = getEffectiveOwnerId(ownerId);
                ownerCache.set(response.drone_id, effectiveOwnerId || ownerId || null);
                ownerCacheUpdatedAt = Date.now();
            }
            return response;
        },

        // Commands
        sendCommand: async (droneId, command, ownerId = null) => {
            const resolvedOwnerId = await resolveOwnerId(droneId, ownerId);
            const payload = { drone_id: droneId, ...command };
            if (resolvedOwnerId) payload.owner_id = resolvedOwnerId;
            return request('/v1/commands', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        holdDrone: async (droneId, duration = 30, ownerId = null) => {
            const resolvedOwnerId = await resolveOwnerId(droneId, ownerId);
            const payload = {
                drone_id: droneId,
                type: 'HOLD',
                duration_secs: duration
            };
            if (resolvedOwnerId) payload.owner_id = resolvedOwnerId;
            return request('/v1/commands', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        resumeDrone: async (droneId, ownerId = null) => {
            const resolvedOwnerId = await resolveOwnerId(droneId, ownerId);
            const payload = {
                drone_id: droneId,
                type: 'RESUME'
            };
            if (resolvedOwnerId) payload.owner_id = resolvedOwnerId;
            return request('/v1/commands', {
                method: 'POST',
                body: JSON.stringify(payload)
            });
        },

        // Conflicts
        getConflicts: (ownerId = null) => {
            const effectiveOwnerId = getEffectiveOwnerId(ownerId);
            const params = new URLSearchParams();
            if (effectiveOwnerId) params.set('owner_id', effectiveOwnerId);
            const url = `/v1/conflicts${params.toString() ? `?${params.toString()}` : ''}`;
            return request(url);
        },

        // Conformance
        getConformance: (ownerId = null) => {
            const effectiveOwnerId = getEffectiveOwnerId(ownerId);
            const url = effectiveOwnerId ? `/v1/conformance?owner_id=${encodeURIComponent(effectiveOwnerId)}` : '/v1/conformance';
            return request(url);
        },

        // DAA advisories
        getDaa: (ownerId = null, activeOnly = true) => {
            const params = new URLSearchParams();
            const effectiveOwnerId = getEffectiveOwnerId(ownerId);
            if (effectiveOwnerId) params.set('owner_id', effectiveOwnerId);
            if (activeOnly !== null && activeOnly !== undefined) {
                params.set('active_only', String(activeOnly));
            }
            const url = `/v1/daa${params.toString() ? `?${params.toString()}` : ''}`;
            return request(url);
        },

        // Geofences
        getGeofences: () => request('/v1/geofences'),
        createGeofence: (payload) => request('/v1/geofences', {
            method: 'POST',
            body: JSON.stringify(payload)
        }),
        updateGeofence: (id, payload) => request(`/v1/geofences/${id}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        }),
        deleteGeofence: (id) => request(`/v1/geofences/${id}`, {
            method: 'DELETE'
        }),

        // Flight Declarations (Flight Blender)
        getFlightDeclarations: async (params = {}) => {
            const search = new URLSearchParams(params);
            const endpoint = `/api/blender/flight-declarations${search.toString() ? `?${search}` : ''}`;
            const response = await requestLocal(endpoint);
            return response.results || response;
        },

        getFlightDeclaration: (id) => {
            const safeId = encodeURIComponent(id);
            return requestLocal(`/api/blender/flight-declarations/${safeId}`);
        },

        createFlightDeclaration: (payload) => requestLocal('/api/blender/flight-declarations', {
            method: 'POST',
            body: JSON.stringify(payload)
        }),

        // Flight Plans (ATC-Drone)
        createFlightPlan: async (payload) => {
            const plan = { ...(payload || {}) };
            if (plan.owner_id === undefined || plan.owner_id === null) {
                plan.owner_id = await resolveOwnerId(plan.drone_id, plan.owner_id);
            }
            return request('/v1/flights/plan', {
                method: 'POST',
                body: JSON.stringify(plan)
            });
        },
        getFlightPlans: (ownerId = null) => {
            const effectiveOwnerId = getEffectiveOwnerId(ownerId);
            const params = new URLSearchParams();
            if (effectiveOwnerId) params.set('owner_id', effectiveOwnerId);
            const url = `/v1/flights${params.toString() ? `?${params.toString()}` : ''}`;
            return request(url);
        },

        // Compliance
        getComplianceWeather: (lat, lon) => {
            const params = new URLSearchParams({ lat, lon });
            return requestLocal(`/api/compliance/weather?${params.toString()}`);
        },
        getComplianceAnalysis: (payload) => requestLocal('/api/compliance/analyze', {
            method: 'POST',
            body: JSON.stringify(payload)
        }),

        // Stats (aggregated for dashboard)
        async getStats() {
            try {
                const effectiveOwnerId = getEffectiveOwnerId();
                const [drones, conflicts, geofences, conformance] = await Promise.all([
                    this.getDrones(effectiveOwnerId).catch(() => []),
                    this.getConflicts(effectiveOwnerId).catch(() => []),
                    this.getGeofences().catch(() => []),
                    this.getConformance(effectiveOwnerId).catch(() => [])
                ]);

                const online = drones.filter(d => isOnlineStatus(d.status)).length;
                const flying = drones.filter(d => isFlyingStatus(d.status)).length;
                const nonconforming = conformance.filter(c => c.status === 'nonconforming').length;
                const visibleDroneIds = new Set(drones.map(d => d.drone_id));
                const visibleConflicts = effectiveOwnerId
                    ? conflicts.filter(c => visibleDroneIds.has(c.drone1_id) || visibleDroneIds.has(c.drone2_id))
                    : conflicts;

                return {
                    dronesOnline: online,
                    dronesFlying: flying,
                    dronesTotal: drones.length,
                    conflicts: visibleConflicts.length,
                    geofences: geofences.length,
                    conformanceNoncompliant: nonconforming,
                    drones: drones,
                    conflictData: visibleConflicts,
                    conformanceData: conformance
                };
            } catch (error) {
                console.error('[API] getStats failed:', error);
                return null;
            }
        },

        // Utility
        getLastUpdate: () => lastUpdate,
        getServerUrl: () => ATC_SERVER_URL
    };
})();

// Update status bar on load
document.addEventListener('DOMContentLoaded', () => {
    // Update drone count in status bar
    API.getStats().then(stats => {
        if (stats) {
            const droneCountEl = document.getElementById('droneCountValue');
            const conflictCountEl = document.getElementById('conflictCountValue');

            if (droneCountEl) droneCountEl.textContent = stats.dronesOnline;
            if (conflictCountEl) conflictCountEl.textContent = stats.conflicts;
        }
    }).catch(() => {
        // Server offline - that's ok
    });
});
