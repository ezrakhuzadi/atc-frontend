/**
 * ATC Camera Controls
 * Shared UI widget that adds orbit-style heading/tilt/zoom controls to any Cesium.Viewer.
 *
 * Key behavior:
 * - N/E/S/W + arrows ORBIT AROUND A TARGET POINT (so you can see buildings from different sides).
 * - Target defaults to the screen center pick, and stays pinned until you recenter.
 * - Free mode exits Cesium lookAtTransform for normal navigation.
 */

(function () {
    'use strict';

    const TWO_PI = Math.PI * 2;
    const STATE = new WeakMap();

    function toRad(deg) {
        return (deg * Math.PI) / 180;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function normalizeHeading(rad) {
        let value = rad % TWO_PI;
        if (value < 0) value += TWO_PI;
        return value;
    }

    function ensurePositionedContainer(container) {
        if (!container || typeof window === 'undefined') return;
        const style = window.getComputedStyle(container);
        if (style && style.position === 'static') {
            container.style.position = 'relative';
        }
    }

    function getState(viewer) {
        if (STATE.has(viewer)) return STATE.get(viewer);
        const state = {
            mode: 'free',
            collapsed: false,
            target: null,
            headingRad: 0,
            pitchRad: toRad(-45),
            rangeM: 1200
        };
        STATE.set(viewer, state);
        return state;
    }

    function pickWorldPosition(viewer, windowPosition) {
        const Cesium = window.Cesium;
        if (!Cesium || !viewer) return null;

        const scene = viewer.scene;
        if (!scene) return null;

        if (scene.pickPositionSupported) {
            try {
                const picked = scene.pickPosition(windowPosition);
                if (picked) return picked;
            } catch (err) {
                // Ignore pickPosition failures; fall back to globe.
            }
        }

        const ray = viewer.camera.getPickRay(windowPosition);
        if (ray) {
            const globePick = scene.globe && typeof scene.globe.pick === 'function'
                ? scene.globe.pick(ray, scene)
                : null;
            if (globePick) return globePick;
        }

        if (typeof viewer.camera.pickEllipsoid === 'function' && scene.globe && scene.globe.ellipsoid) {
            return viewer.camera.pickEllipsoid(windowPosition, scene.globe.ellipsoid);
        }

        return null;
    }

    function pickScreenCenter(viewer) {
        const Cesium = window.Cesium;
        if (!Cesium || !viewer || !viewer.scene || !viewer.scene.canvas) return null;
        const canvas = viewer.scene.canvas;
        const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
        return pickWorldPosition(viewer, center);
    }

    function tryEntityPosition(entity, viewer) {
        const Cesium = window.Cesium;
        if (!Cesium || !entity) return null;
        const time = viewer && viewer.clock ? viewer.clock.currentTime : null;
        try {
            if (entity.position && typeof entity.position.getValue === 'function' && time) {
                return entity.position.getValue(time);
            }
        } catch (err) {
            return null;
        }
        return null;
    }

    function resolveDefaultTarget(viewer) {
        if (!viewer) return null;
        const selected = viewer.selectedEntity ? tryEntityPosition(viewer.selectedEntity, viewer) : null;
        if (selected) return selected;

        const tracked = viewer.trackedEntity ? tryEntityPosition(viewer.trackedEntity, viewer) : null;
        if (tracked) return tracked;

        return pickScreenCenter(viewer);
    }

    function computeOrbitFromCamera(viewer, target) {
        const Cesium = window.Cesium;
        if (!Cesium || !viewer || !target) return null;

        const camera = viewer.camera;
        if (!camera) return null;

        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(target);
        const inverse = Cesium.Matrix4.inverseTransformation(transform, new Cesium.Matrix4());
        const localPos = Cesium.Matrix4.multiplyByPoint(inverse, camera.positionWC, new Cesium.Cartesian3());

        const x = localPos.x;
        const y = localPos.y;
        const z = localPos.z;
        const horizontal = Math.sqrt(x * x + y * y);
        const range = Math.sqrt(horizontal * horizontal + z * z);
        if (!Number.isFinite(range) || range <= 0) return null;

        const heading = normalizeHeading(Math.atan2(x, y));
        const pitch = horizontal > 0 ? -Math.atan2(z, horizontal) : toRad(-89);

        return { heading, pitch, range };
    }

    function applyOrbit(viewer, state) {
        const Cesium = window.Cesium;
        if (!Cesium || !viewer || !state || !state.target) return;

        const pitchMin = toRad(-89);
        const pitchMax = toRad(-3);
        const rangeMin = 30;
        const rangeMax = 750000;

        state.headingRad = normalizeHeading(state.headingRad);
        state.pitchRad = clamp(state.pitchRad, pitchMin, pitchMax);
        state.rangeM = clamp(state.rangeM, rangeMin, rangeMax);

        viewer.camera.lookAt(
            state.target,
            new Cesium.HeadingPitchRange(state.headingRad, state.pitchRad, state.rangeM)
        );
    }

    function setMode(rootEl, viewer, state, mode) {
        const Cesium = window.Cesium;
        if (!viewer || !state) return;

        state.mode = mode;

        if (mode === 'free' && Cesium && viewer.camera) {
            viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        }

        const freeBtn = rootEl.querySelector('[data-action="mode"][data-mode="free"]');
        const orbitBtn = rootEl.querySelector('[data-action="mode"][data-mode="orbit"]');
        if (freeBtn) freeBtn.classList.toggle('active', mode === 'free');
        if (orbitBtn) orbitBtn.classList.toggle('active', mode === 'orbit');
    }

    function ensureOrbit(rootEl, viewer, state, { recenter = false } = {}) {
        if (!viewer || !state) return false;

        if (recenter || !state.target) {
            state.target = resolveDefaultTarget(viewer);
        }

        if (!state.target) return false;

        const orbitNow = computeOrbitFromCamera(viewer, state.target);
        if (orbitNow) {
            state.headingRad = orbitNow.heading;
            state.pitchRad = orbitNow.pitch;
            state.rangeM = orbitNow.range;
        }

        setMode(rootEl, viewer, state, 'orbit');
        applyOrbit(viewer, state);
        return true;
    }

    function attach(viewer, options = {}) {
        if (!viewer || !viewer.container) return null;

        const container = viewer.container;
        const existing = container.querySelector('[data-atc-camera-controls="1"]');
        if (existing) return existing;

        ensurePositionedContainer(container);

        const state = getState(viewer);
        const config = {
            headingStepRad: Number.isFinite(options.headingStepRad) ? options.headingStepRad : toRad(12),
            pitchStepRad: Number.isFinite(options.pitchStepRad) ? options.pitchStepRad : toRad(7),
            zoomFactor: Number.isFinite(options.zoomFactor) ? options.zoomFactor : 0.18,
            defaultHeadingRad: Number.isFinite(options.defaultHeadingRad) ? options.defaultHeadingRad : 0,
            defaultPitchRad: Number.isFinite(options.defaultPitchRad) ? options.defaultPitchRad : toRad(-38)
        };

        const root = document.createElement('div');
        root.className = 'atc-camera-controls';
        root.dataset.atcCameraControls = '1';
        root.innerHTML = `
            <div class="atc-camera-controls__panel" role="group" aria-label="Camera controls">
                <div class="atc-camera-controls__header">
                    <div class="atc-camera-controls__title">Camera</div>
                    <button type="button" class="atc-camera-controls__toggle" data-action="toggle" aria-expanded="true" title="Collapse controls">—</button>
                </div>

                <div class="atc-camera-controls__body">
                    <div class="atc-camera-controls__row atc-camera-controls__row--mode" role="group" aria-label="Camera mode">
                        <button type="button" class="atc-camera-controls__chip active" data-action="mode" data-mode="free" title="Free camera">Free</button>
                        <button type="button" class="atc-camera-controls__chip" data-action="mode" data-mode="orbit" title="Orbit around a target point">Orbit</button>
                        <button type="button" class="atc-camera-controls__chip" data-action="recenter" title="Recenter orbit target to screen center">Target</button>
                    </div>

                    <div class="atc-camera-controls__row atc-camera-controls__row--presets" role="group" aria-label="Orbit to cardinal view">
                        <button type="button" class="atc-camera-controls__btn" data-action="orbit-cardinal" data-heading-deg="0" title="View from North (looking South)">N</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="orbit-cardinal" data-heading-deg="90" title="View from East (looking West)">E</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="orbit-cardinal" data-heading-deg="180" title="View from South (looking North)">S</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="orbit-cardinal" data-heading-deg="270" title="View from West (looking East)">W</button>
                    </div>

                    <div class="atc-camera-controls__grid" role="group" aria-label="Orbit controls">
                        <div></div>
                        <button type="button" class="atc-camera-controls__btn" data-action="tilt-up" title="Tilt up">▲</button>
                        <div></div>

                        <button type="button" class="atc-camera-controls__btn" data-action="rotate-left" title="Rotate left">◀</button>
                        <button type="button" class="atc-camera-controls__btn atc-camera-controls__btn--primary" data-action="reset" title="Reset view">0</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="rotate-right" title="Rotate right">▶</button>

                        <div></div>
                        <button type="button" class="atc-camera-controls__btn" data-action="tilt-down" title="Tilt down">▼</button>
                        <div></div>
                    </div>

                    <div class="atc-camera-controls__row atc-camera-controls__row--zoom" role="group" aria-label="Zoom">
                        <button type="button" class="atc-camera-controls__btn" data-action="zoom-in" title="Zoom in">+</button>
                        <button type="button" class="atc-camera-controls__btn" data-action="zoom-out" title="Zoom out">−</button>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(root);

        function toggleCollapsed() {
            const panel = root.querySelector('.atc-camera-controls__panel');
            const body = root.querySelector('.atc-camera-controls__body');
            const toggle = root.querySelector('[data-action="toggle"]');
            if (!panel || !body || !toggle) return;

            const isCollapsed = panel.classList.toggle('atc-camera-controls__panel--collapsed');
            body.style.display = isCollapsed ? 'none' : '';
            toggle.textContent = isCollapsed ? '+' : '—';
            toggle.setAttribute('aria-expanded', String(!isCollapsed));
            toggle.title = isCollapsed ? 'Expand controls' : 'Collapse controls';
            state.collapsed = isCollapsed;
        }

        root.addEventListener('click', (event) => {
            const target = event.target && event.target.closest ? event.target.closest('button[data-action]') : null;
            if (!target) return;

            const action = target.getAttribute('data-action');

            switch (action) {
                case 'toggle':
                    toggleCollapsed();
                    break;
                case 'mode': {
                    const mode = target.getAttribute('data-mode');
                    if (mode !== 'free' && mode !== 'orbit') return;
                    if (mode === 'orbit') {
                        ensureOrbit(root, viewer, state, { recenter: false });
                    } else {
                        setMode(root, viewer, state, 'free');
                    }
                    break;
                }
                case 'recenter':
                    ensureOrbit(root, viewer, state, { recenter: true });
                    break;
                case 'rotate-left':
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.headingRad = normalizeHeading(state.headingRad - config.headingStepRad);
                    applyOrbit(viewer, state);
                    break;
                case 'rotate-right':
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.headingRad = normalizeHeading(state.headingRad + config.headingStepRad);
                    applyOrbit(viewer, state);
                    break;
                case 'tilt-up':
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.pitchRad = state.pitchRad + config.pitchStepRad;
                    applyOrbit(viewer, state);
                    break;
                case 'tilt-down':
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.pitchRad = state.pitchRad - config.pitchStepRad;
                    applyOrbit(viewer, state);
                    break;
                case 'zoom-in':
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.rangeM = state.rangeM - Math.max(25, state.rangeM * config.zoomFactor);
                    applyOrbit(viewer, state);
                    break;
                case 'zoom-out':
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.rangeM = state.rangeM + Math.max(25, state.rangeM * config.zoomFactor);
                    applyOrbit(viewer, state);
                    break;
                case 'orbit-cardinal': {
                    const deg = Number(target.getAttribute('data-heading-deg'));
                    if (!Number.isFinite(deg)) return;
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.headingRad = normalizeHeading(toRad(deg));
                    applyOrbit(viewer, state);
                    break;
                }
                case 'reset': {
                    if (!ensureOrbit(root, viewer, state)) return;
                    state.headingRad = normalizeHeading(config.defaultHeadingRad);
                    state.pitchRad = config.defaultPitchRad;
                    applyOrbit(viewer, state);
                    break;
                }
                default:
                    break;
            }
        });

        setMode(root, viewer, state, state.mode);
        return root;
    }

    window.ATCCameraControls = Object.assign(window.ATCCameraControls || {}, { attach });
})();
