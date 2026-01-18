/**
 * Drone Detail Page Logic
 */

(function () {
    'use strict';

    const REFRESH_INTERVAL = 2000;
    const statusUtils = window.ATCStatus || {
        getStatusClass: () => 'online',
        getStatusLabel: (status) => status || 'Unknown'
    };

    const droneIdEl = document.getElementById('droneId');
    if (!droneIdEl) return;
    const droneId = droneIdEl.textContent.trim();
    if (!droneId) return;

    let lastKnownStatus = null;

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    function setStatus(status) {
        const statusDot = document.getElementById('statusDot');
        const statusBadge = document.getElementById('statusBadge');
        const className = statusUtils.getStatusClass(status);
        const label = statusUtils.getStatusLabel(status);

        if (statusDot) statusDot.className = `status-dot ${className}`;
        if (statusBadge) {
            statusBadge.className = `status-badge ${className}`;
            statusBadge.textContent = label;
        }
    }

    function formatRelativeTime(timestamp) {
        if (!timestamp) return '--';
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '--';
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 5) return 'just now';
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    }

    function setControlsEnabled(enabled) {
        const holdBtn = document.getElementById('holdDrone');
        const resumeBtn = document.getElementById('resumeDrone');
        const sendBtn = document.getElementById('sendCommand');
        const commandType = document.getElementById('commandType');
        const targetAltitude = document.getElementById('targetAltitude');

        if (holdBtn) holdBtn.disabled = !enabled;
        if (resumeBtn) resumeBtn.disabled = !enabled;
        if (sendBtn) sendBtn.disabled = !enabled;
        if (commandType) commandType.disabled = !enabled;
        if (targetAltitude) targetAltitude.disabled = !enabled;
    }

    async function refreshDrone() {
        try {
            const drones = await API.getDrones();
            const drone = (drones || []).find(entry => entry.drone_id === droneId);

            if (!drone) {
                if (lastKnownStatus !== 'lost') {
                    setStatus('lost');
                    lastKnownStatus = 'lost';
                }
                setText('altitude', '--');
                setText('speed', '--');
                setText('heading', '--');
                setText('battery', '--');
                setText('lat', '--');
                setText('lon', '--');
                setText('lastUpdate', '--');
                setControlsEnabled(false);
                return;
            }

            lastKnownStatus = drone.status;
            setStatus(drone.status);
            setControlsEnabled(true);

            setText('altitude', `${drone.altitude_m.toFixed(1)}m`);
            setText('speed', `${drone.speed_mps.toFixed(1)} m/s`);
            setText('heading', `${drone.heading_deg.toFixed(0)} deg`);
            setText('battery', '--');
            setText('lat', drone.lat.toFixed(6));
            setText('lon', drone.lon.toFixed(6));
            setText('lastUpdate', formatRelativeTime(drone.last_update));
        } catch (error) {
            console.error('[DroneDetail] Refresh failed:', error);
        }
    }

    async function holdDrone() {
        const statusEl = document.getElementById('commandStatus');
        if (statusEl) statusEl.textContent = 'Sending HOLD...';
        try {
            await API.holdDrone(droneId, 30);
            if (statusEl) statusEl.textContent = 'HOLD sent';
            refreshDrone();
        } catch (error) {
            if (statusEl) statusEl.textContent = 'HOLD failed';
            alert(`Failed to send HOLD: ${error.message}`);
        }
    }

    async function resumeDrone() {
        const statusEl = document.getElementById('commandStatus');
        if (statusEl) statusEl.textContent = 'Sending RESUME...';
        try {
            await API.resumeDrone(droneId);
            if (statusEl) statusEl.textContent = 'RESUME sent';
            refreshDrone();
        } catch (error) {
            if (statusEl) statusEl.textContent = 'RESUME failed';
            alert(`Failed to send RESUME: ${error.message}`);
        }
    }

    async function sendCommand() {
        const commandType = document.getElementById('commandType');
        const targetAltitude = document.getElementById('targetAltitude');
        const statusEl = document.getElementById('commandStatus');

        if (!commandType) return;
        const selection = commandType.value;
        if (statusEl) statusEl.textContent = 'Sending command...';

        try {
            if (selection === 'hold') {
                await API.holdDrone(droneId, 30);
            } else if (selection === 'resume') {
                await API.resumeDrone(droneId);
            } else if (selection === 'altitude') {
                const altitudeValue = Number(targetAltitude?.value);
                if (!Number.isFinite(altitudeValue)) {
                    alert('Enter a valid altitude.');
                    if (statusEl) statusEl.textContent = 'Invalid altitude';
                    return;
                }
                await API.sendCommand(droneId, {
                    type: 'ALTITUDE_CHANGE',
                    target_altitude_m: altitudeValue
                });
            }
            if (statusEl) statusEl.textContent = 'Command sent';
            refreshDrone();
        } catch (error) {
            if (statusEl) statusEl.textContent = 'Command failed';
            alert(`Command failed: ${error.message}`);
        }
    }

    function handleCommandTypeChange() {
        const commandType = document.getElementById('commandType');
        const altitudeGroup = document.getElementById('altitudeGroup');
        if (!commandType || !altitudeGroup) return;
        altitudeGroup.style.display = commandType.value === 'altitude' ? 'block' : 'none';
    }

    document.addEventListener('DOMContentLoaded', () => {
        const holdBtn = document.getElementById('holdDrone');
        const resumeBtn = document.getElementById('resumeDrone');
        const sendBtn = document.getElementById('sendCommand');
        const commandType = document.getElementById('commandType');

        if (holdBtn) holdBtn.addEventListener('click', holdDrone);
        if (resumeBtn) resumeBtn.addEventListener('click', resumeDrone);
        if (sendBtn) sendBtn.addEventListener('click', sendCommand);
        if (commandType) commandType.addEventListener('change', handleCommandTypeChange);

        handleCommandTypeChange();
        refreshDrone();
        setInterval(refreshDrone, REFRESH_INTERVAL);
    });
})();
