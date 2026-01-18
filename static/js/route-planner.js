/**
 * Route Planner - Building-aware route analysis
 * Uses Cesium terrain + OSM buildings to compute safe routes.
 */

(function (root) {
    'use strict';

    const DEFAULTS = {
        OSM_BUILDINGS_ASSET_ID: 96188,
        FAA_MAX_ALTITUDE_AGL_M: 121,
        DEFAULT_SAFETY_BUFFER_M: 20,
        DEFAULT_SAMPLE_SPACING_M: 5,
        MIN_SAMPLE_SPACING_M: 5,
        MAX_SAMPLE_SPACING_M: 30,
        TARGET_STEP_COUNT: 320,
        FAN_OFFSETS: [-90, -75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75, 90],
        TILESET_LOAD_TIMEOUT_MS: 15000,
        TILESET_POLL_INTERVAL_MS: 200
    };

    const state = {
        viewer: null,
        osmTileset: null,
        osmTilesetPromise: null
    };

    function toRad(deg) {
        return deg * Math.PI / 180;
    }

    function calculateDistance(p1, p2) {
        const R = 6371000;
        const phi1 = toRad(p1.lat);
        const phi2 = toRad(p2.lat);
        const dPhi = toRad(p2.lat - p1.lat);
        const dLambda = toRad(p2.lon - p1.lon);
        const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function computeRouteDistance(waypoints) {
        if (!Array.isArray(waypoints) || waypoints.length < 2) return 0;
        let distance = 0;
        for (let i = 1; i < waypoints.length; i += 1) {
            distance += calculateDistance(waypoints[i - 1], waypoints[i]);
        }
        return distance;
    }

    function resolveSampleSpacing(waypoints, config) {
        const distance = computeRouteDistance(waypoints);
        if (!distance) return config.DEFAULT_SAMPLE_SPACING_M;
        const spacing = distance / config.TARGET_STEP_COUNT;
        return Math.min(config.MAX_SAMPLE_SPACING_M, Math.max(config.MIN_SAMPLE_SPACING_M, spacing));
    }

    function normalizeWaypoints(waypoints, defaultAlt) {
        const fallbackAlt = Number.isFinite(defaultAlt) ? defaultAlt : 60;
        return waypoints.map((wp) => ({
            lat: wp.lat,
            lon: wp.lon,
            alt: Number.isFinite(wp.alt) ? wp.alt : fallbackAlt
        }));
    }

    async function loadOsmBuildings(config) {
        if (state.osmTileset) return state.osmTileset;
        if (state.osmTilesetPromise) return state.osmTilesetPromise;

        state.osmTilesetPromise = Cesium.Cesium3DTileset.fromIonAssetId(config.OSM_BUILDINGS_ASSET_ID)
            .then((tileset) => {
                state.osmTileset = tileset;
                state.viewer.scene.primitives.add(tileset);
                return tileset;
            })
            .catch((error) => {
                console.warn('[RoutePlanner] OSM Buildings failed to load:', error);
                state.osmTilesetPromise = null;
                return null;
            });

        return state.osmTilesetPromise;
    }

    async function waitForTiles(tileset, config) {
        if (!tileset) return false;

        const start = performance.now();
        const timeoutMs = config.TILESET_LOAD_TIMEOUT_MS;
        const pollMs = config.TILESET_POLL_INTERVAL_MS;

        while (performance.now() - start < timeoutMs) {
            state.viewer.scene.render();
            if (tileset.tilesLoaded) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }

        return false;
    }

    function generateGridSamples(waypoints, spacingMeters, config) {
        if (waypoints.length < 2) return null;

        const lanes = config.FAN_OFFSETS.map(() => []);
        const centerLine = [];
        const waypointIndices = [0];
        let totalSteps = 0;

        for (let i = 0; i < waypoints.length - 1; i += 1) {
            const start = waypoints[i];
            const end = waypoints[i + 1];

            const startCarto = Cesium.Cartographic.fromDegrees(start.lon, start.lat);
            const endCarto = Cesium.Cartographic.fromDegrees(end.lon, end.lat);
            const geodesic = new Cesium.EllipsoidGeodesic(startCarto, endCarto);
            const distance = geodesic.surfaceDistance;
            const heading = geodesic.startHeading;
            const rightHeading = heading + (Math.PI / 2);

            const numSteps = Math.max(1, Math.ceil(distance / spacingMeters));

            for (let j = 0; j <= numSteps; j += 1) {
                if (j === numSteps && i < waypoints.length - 2) continue;

                const fraction = j / numSteps;
                const centerPoint = geodesic.interpolateUsingSurfaceDistance(fraction * distance);
                const alt = start.alt + fraction * (end.alt - start.alt);
                const centerCart = Cesium.Cartographic.toCartesian(centerPoint);

                centerLine.push({
                    lat: Cesium.Math.toDegrees(centerPoint.latitude),
                    lon: Cesium.Math.toDegrees(centerPoint.longitude),
                    alt: alt
                });

                config.FAN_OFFSETS.forEach((offset, laneIdx) => {
                    if (offset === 0) {
                        lanes[laneIdx].push({
                            lat: Cesium.Math.toDegrees(centerPoint.latitude),
                            lon: Cesium.Math.toDegrees(centerPoint.longitude),
                            alt: alt
                        });
                        return;
                    }

                    const transform = Cesium.Transforms.eastNorthUpToFixedFrame(centerCart);
                    const matrix = Cesium.Matrix4.getMatrix3(transform, new Cesium.Matrix3());
                    const enuRight = new Cesium.Cartesian3(
                        Math.sin(rightHeading),
                        Math.cos(rightHeading),
                        0
                    );
                    const offsetVec = Cesium.Cartesian3.multiplyByScalar(enuRight, offset, new Cesium.Cartesian3());
                    const worldOffset = Cesium.Matrix3.multiplyByVector(matrix, offsetVec, new Cesium.Cartesian3());
                    const finalPos = Cesium.Cartesian3.add(centerCart, worldOffset, new Cesium.Cartesian3());
                    const finalCarto = Cesium.Cartographic.fromCartesian(finalPos);

                    lanes[laneIdx].push({
                        lat: Cesium.Math.toDegrees(finalCarto.latitude),
                        lon: Cesium.Math.toDegrees(finalCarto.longitude),
                        alt: alt
                    });
                });
            }

            totalSteps = centerLine.length;
            if (i < waypoints.length - 2) {
                waypointIndices.push(totalSteps - 1);
            }
        }

        waypointIndices.push(centerLine.length - 1);

        return { lanes, centerLine, waypointIndices };
    }

    async function analyzeGrid(grid, config) {
        if (!grid) return null;

        if (state.osmTileset && !state.osmTileset.ready) {
            await state.osmTileset.readyPromise;
        }

        if (state.osmTileset) {
            await waitForTiles(state.osmTileset, config);
        }

        const allPoints = [];
        const map = [];

        grid.lanes.forEach((lane, laneIdx) => {
            lane.forEach((point, pointIdx) => {
                const pos = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 1000);
                allPoints.push(pos);
                map.push({ laneIdx, pointIdx });
            });
        });

        let clampedPositions = [];
        try {
            clampedPositions = await state.viewer.scene.clampToHeightMostDetailed(
                allPoints,
                [],
                1.0
            );
        } catch (error) {
            console.warn('[RoutePlanner] clampToHeightMostDetailed failed:', error);
            clampedPositions = allPoints.map((pos) => {
                if (!pos) return null;
                try {
                    const carto = Cesium.Cartographic.fromCartesian(pos);
                    return carto ? Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0) : null;
                } catch (e) {
                    return null;
                }
            });
        }

        const terrainCartos = allPoints.map((pos) => {
            if (!pos) return Cesium.Cartographic.fromDegrees(0, 0, 0);
            try {
                return Cesium.Cartographic.fromCartesian(pos);
            } catch (e) {
                return Cesium.Cartographic.fromDegrees(0, 0, 0);
            }
        }).filter((carto) => carto !== null);

        let terrainHeights;
        try {
            terrainHeights = await Cesium.sampleTerrainMostDetailed(state.viewer.terrainProvider, terrainCartos);
        } catch (error) {
            console.warn('[RoutePlanner] Terrain sampling failed:', error);
            terrainHeights = terrainCartos;
        }

        let maxObstacleHeight = -9999;
        let maxBuildingHeight = 0;
        let buildingsDetected = 0;

        clampedPositions.forEach((clampedPos, i) => {
            const { laneIdx, pointIdx } = map[i];
            const point = grid.lanes[laneIdx][pointIdx];
            const terrainCarto = terrainHeights[i];

            if (!clampedPos) {
                point.obstacleHeight = terrainCarto ? terrainCarto.height : 0;
                point.terrainHeight = terrainCarto ? terrainCarto.height : 0;
                point.buildingHeight = 0;
                return;
            }

            const clampedCarto = Cesium.Cartographic.fromCartesian(clampedPos);
            if (!clampedCarto) {
                point.obstacleHeight = terrainCarto ? terrainCarto.height : 0;
                point.terrainHeight = terrainCarto ? terrainCarto.height : 0;
                point.buildingHeight = 0;
                return;
            }

            const obstacleHeight = clampedCarto.height || 0;
            const terrainHeight = terrainCarto ? (terrainCarto.height || 0) : 0;

            point.obstacleHeight = obstacleHeight;
            point.terrainHeight = terrainHeight;
            point.buildingHeight = Math.max(0, obstacleHeight - terrainHeight);

            if (point.buildingHeight > 1) {
                buildingsDetected += 1;
            }

            maxObstacleHeight = Math.max(maxObstacleHeight, obstacleHeight);
            maxBuildingHeight = Math.max(maxBuildingHeight, point.buildingHeight);
        });

        return {
            grid,
            maxObstacleHeight,
            maxBuildingHeight,
            buildingsDetected
        };
    }

    function validateFAA(routeAnalysis, plannedAltitude, config) {
        const violations = [];
        let isValid = true;

        for (const point of routeAnalysis.points) {
            const agl = plannedAltitude - point.terrainHeight;
            const clearance = plannedAltitude - point.obstacleHeight;

            if (agl > config.FAA_MAX_ALTITUDE_AGL_M) {
                violations.push({
                    type: 'FAA_ALTITUDE_EXCEEDED',
                    lat: point.lat,
                    lon: point.lon,
                    altitude: plannedAltitude,
                    agl
                });
            }

            if (clearance < config.DEFAULT_SAFETY_BUFFER_M) {
                violations.push({
                    type: 'OBSTACLE_CLEARANCE',
                    lat: point.lat,
                    lon: point.lon,
                    altitude: plannedAltitude,
                    clearance
                });
            }
        }

        if (violations.length > 0) {
            isValid = false;
        }

        const suggestedAltitude = routeAnalysis.maxObstacleHeight + config.DEFAULT_SAFETY_BUFFER_M;
        const minTerrain = Math.min(...routeAnalysis.points.map((p) => p.terrainHeight));
        const suggestedAGL = suggestedAltitude - minTerrain;

        return {
            isValid,
            violations,
            suggestedAltitude,
            suggestedAGL,
            maxObstacleHeight: routeAnalysis.maxObstacleHeight,
            faaCompliant: suggestedAGL <= config.FAA_MAX_ALTITUDE_AGL_M,
            summary: isValid
                ? `Route clear at ${plannedAltitude.toFixed(0)}m`
                : `Route blocked by ${violations.length} violation(s)`
        };
    }

    async function focusCameraOnRoute(waypoints) {
        if (!state.viewer || waypoints.length < 2) return;
        const boundingSphere = Cesium.BoundingSphere.fromPoints(
            waypoints.map((wp) => Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.alt || 0))
        );

        state.viewer.camera.flyToBoundingSphere(boundingSphere, {
            duration: 0.8,
            offset: new Cesium.HeadingPitchRange(0, -1.0, boundingSphere.radius * 2.5)
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    async function calculateRoute(inputWaypoints, options = {}) {
        if (!state.viewer) {
            throw new Error('RoutePlanner has no viewer set');
        }

        const config = { ...DEFAULTS, ...options };
        if (!Array.isArray(inputWaypoints) || inputWaypoints.length < 2) {
            throw new Error('Need at least 2 waypoints to calculate a route');
        }

        const normalized = normalizeWaypoints(inputWaypoints, config.defaultAltitudeM);
        const plannedAltitude = Number.isFinite(config.plannedAltitude)
            ? config.plannedAltitude
            : normalized.reduce((sum, wp) => sum + wp.alt, 0) / normalized.length;

        await loadOsmBuildings(config);
        await focusCameraOnRoute(normalized);

        const spacing = resolveSampleSpacing(normalized, config);
        const grid = generateGridSamples(normalized, spacing, config);
        const analysis = await analyzeGrid(grid, config);
        if (!analysis) {
            return {
                waypoints: normalized,
                samplePoints: 0,
                plannedAltitude,
                analysis: { points: [], maxObstacleHeight: 0, maxBuildingHeight: 0 },
                validation: { isValid: false, violations: [], summary: 'Route analysis failed' },
                optimized: false,
                timestamp: new Date().toISOString()
            };
        }

        const centerLaneIdx = Math.floor(grid.lanes.length / 2);
        const centerLanePoints = grid.lanes[centerLaneIdx];
        const centerAnalysis = {
            points: centerLanePoints.map((point) => ({
                ...point,
                obstacleHeight: point.obstacleHeight,
                terrainHeight: point.terrainHeight,
                buildingHeight: point.buildingHeight || 0
            })),
            maxObstacleHeight: analysis.maxObstacleHeight,
            maxBuildingHeight: analysis.maxBuildingHeight || 0
        };

        const straightValidation = validateFAA(centerAnalysis, plannedAltitude, config);

        if (straightValidation.isValid) {
            return {
                waypoints: normalized,
                samplePoints: grid.lanes[0].length * grid.lanes.length,
                plannedAltitude,
                analysis: centerAnalysis,
                validation: straightValidation,
                optimized: false,
                timestamp: new Date().toISOString()
            };
        }

        if (!root.RouteEngine) {
            return {
                waypoints: normalized,
                samplePoints: grid.lanes[0].length * grid.lanes.length,
                plannedAltitude,
                analysis: centerAnalysis,
                validation: straightValidation,
                optimized: false,
                timestamp: new Date().toISOString(),
                warning: 'Route engine unavailable'
            };
        }

        if (typeof root.RouteEngine.configure === 'function') {
            root.RouteEngine.configure({
                FAA_LIMIT_AGL: config.FAA_MAX_ALTITUDE_AGL_M,
                SAFETY_BUFFER_M: config.DEFAULT_SAFETY_BUFFER_M
            });
        }

        const optimization = root.RouteEngine.optimizeFlightPath(normalized, grid);
        if (!optimization.success) {
            return {
                waypoints: normalized,
                samplePoints: grid.lanes[0].length * grid.lanes.length,
                plannedAltitude,
                analysis: centerAnalysis,
                validation: {
                    isValid: false,
                    violations: [],
                    summary: 'No valid path found'
                },
                optimized: false,
                timestamp: new Date().toISOString()
            };
        }

        const validatedWaypoints = await root.RouteEngine.validateAndFixSegments(
            optimization.waypoints,
            state.viewer
        );

        return {
            waypoints: validatedWaypoints,
            originalWaypoints: normalized,
            samplePoints: grid.lanes[0].length * grid.lanes.length,
            optimizedPoints: validatedWaypoints.length,
            plannedAltitude: plannedAltitude,
            analysis: centerAnalysis,
            validation: {
                isValid: true,
                violations: [],
                suggestedAltitude: 0,
                suggestedAGL: 0,
                maxObstacleHeight: analysis.maxObstacleHeight,
                maxBuildingHeight: analysis.maxBuildingHeight || 0,
                faaCompliant: true,
                summary: `Optimized path with ${optimization.nodesVisited} nodes visited`
            },
            optimized: true,
            optimization,
            timestamp: new Date().toISOString()
        };
    }

    async function init(viewer, options = {}) {
        state.viewer = viewer;
        const config = { ...DEFAULTS, ...options };
        if (options.loadBuildings === false) {
            return { viewer };
        }
        await loadOsmBuildings(config);
        return { viewer };
    }

    root.RoutePlanner = {
        init,
        calculateRoute,
        computeRouteDistance
    };
})(typeof window !== 'undefined' ? window : this);
