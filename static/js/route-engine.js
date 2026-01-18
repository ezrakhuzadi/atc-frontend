/**
 * Route Engine - 3D A* Pathfinding
 * Finds an obstacle-aware path through a sampled corridor grid.
 */

(function (root) {
    'use strict';

    const ENGINE_CONFIG = {
        FAA_LIMIT_AGL: 121,
        SAFETY_BUFFER_M: 15,
        CLIMB_SPEED_MPS: 2.0,
        CRUISE_SPEED_MPS: 15.0,
        DESCENT_SPEED_MPS: 3.0,
        COST_TIME_WEIGHT: 1.0,
        COST_CLIMB_PENALTY: 15.0,
        COST_LANE_CHANGE: 50.0,
        COST_PROXIMITY_PENALTY: 100.0,
        EARTH_RADIUS_M: 6371000
    };

    function toRad(deg) { return deg * Math.PI / 180; }

    function calculateDistance(p1, p2) {
        const R = ENGINE_CONFIG.EARTH_RADIUS_M;
        const phi1 = toRad(p1.lat);
        const phi2 = toRad(p2.lat);
        const dPhi = toRad(p2.lat - p1.lat);
        const dLambda = toRad(p2.lon - p1.lon);
        const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function isLineOfSightClear(start, end, allNodes, startIdx, endIdx, grid) {
        let maxAlt = Math.max(start.alt, end.alt);
        for (let i = startIdx; i <= endIdx; i += 1) {
            maxAlt = Math.max(maxAlt, allNodes[i].alt);
        }

        const numLanes = grid.lanes.length;
        const numSteps = grid.lanes[0].length;
        const numSamples = Math.max(5, (endIdx - startIdx) * 2);

        for (let i = 1; i < numSamples; i += 1) {
            const t = i / numSamples;
            const midStep = Math.round(start.step + t * (end.step - start.step));
            const midLane = Math.round(start.lane + t * (end.lane - start.lane));

            if (midLane < 0 || midLane >= numLanes) return false;
            if (midStep < 0 || midStep >= numSteps) return false;

            const gridPoint = grid.lanes[midLane][midStep];
            const obstacleHeight = Math.max(gridPoint.obstacleHeight || 0, gridPoint.terrainHeight || 0);
            const minSafeAlt = obstacleHeight + ENGINE_CONFIG.SAFETY_BUFFER_M;

            if (minSafeAlt > maxAlt) {
                return false;
            }

            if (midLane > 0) {
                const leftPoint = grid.lanes[midLane - 1][midStep];
                const leftHeight = Math.max(leftPoint.obstacleHeight || 0, leftPoint.terrainHeight || 0);
                if (leftHeight + ENGINE_CONFIG.SAFETY_BUFFER_M > maxAlt) {
                    return false;
                }
            }

            if (midLane < numLanes - 1) {
                const rightPoint = grid.lanes[midLane + 1][midStep];
                const rightHeight = Math.max(rightPoint.obstacleHeight || 0, rightPoint.terrainHeight || 0);
                if (rightHeight + ENGINE_CONFIG.SAFETY_BUFFER_M > maxAlt) {
                    return false;
                }
            }
        }

        return true;
    }

    function smoothPath(pathNodes, grid) {
        if (!pathNodes || pathNodes.length <= 2) return pathNodes;

        const smoothed = [pathNodes[0]];
        let currentIdx = 0;

        while (currentIdx < pathNodes.length - 1) {
            let furthestValid = currentIdx + 1;

            for (let targetIdx = currentIdx + 2; targetIdx < pathNodes.length; targetIdx += 1) {
                const start = pathNodes[currentIdx];
                const target = pathNodes[targetIdx];

                if (isLineOfSightClear(start, target, pathNodes, currentIdx, targetIdx, grid)) {
                    furthestValid = targetIdx;
                }
            }

            smoothed.push(pathNodes[furthestValid]);
            currentIdx = furthestValid;
        }

        console.log(`[RouteEngine] Path smoothed: ${pathNodes.length} -> ${smoothed.length} nodes`);
        return smoothed;
    }

    const RouteEngine = {
        configure: function (config) {
            if (!config || typeof config !== 'object') return ENGINE_CONFIG;
            Object.assign(ENGINE_CONFIG, config);
            return ENGINE_CONFIG;
        },

        getConfig: function () {
            return { ...ENGINE_CONFIG };
        },

        optimizeFlightPath: function (originalWaypoints, grid) {
            console.log('[RouteEngine] Starting A* optimization');
            const startTime = performance.now();

            const numLanes = grid.lanes.length;
            const numSteps = grid.lanes[0].length;
            const centerLaneIdx = Math.floor(numLanes / 2);

            const openSet = [];
            const closedSet = new Set();
            const cameFrom = {};

            const startNode = {
                id: `0_${centerLaneIdx}`,
                step: 0,
                lane: centerLaneIdx,
                gScore: 0,
                fScore: 0,
                alt: grid.lanes[centerLaneIdx][0].terrainHeight
            };

            openSet.push(startNode);

            const gScore = {};
            gScore[startNode.id] = 0;

            let finalNode = null;
            let nodesVisited = 0;

            while (openSet.length > 0) {
                openSet.sort((a, b) => a.fScore - b.fScore);
                const current = openSet.shift();
                nodesVisited += 1;

                if (current.step === numSteps - 1 && current.lane === centerLaneIdx) {
                    finalNode = current;
                    break;
                }

                closedSet.add(current.id);
                const nextStep = current.step + 1;
                if (nextStep >= numSteps) continue;

                const candidateLanes = [current.lane - 1, current.lane, current.lane + 1]
                    .filter((lane) => lane >= 0 && lane < numLanes);

                for (const nextLane of candidateLanes) {
                    const nextId = `${nextStep}_${nextLane}`;
                    if (closedSet.has(nextId)) continue;

                    const nextPoint = grid.lanes[nextLane][nextStep];
                    const featureHeight = Math.max(nextPoint.obstacleHeight, nextPoint.terrainHeight);
                    const minSafeAlt = featureHeight + ENGINE_CONFIG.SAFETY_BUFFER_M;
                    const faaCeiling = nextPoint.terrainHeight + ENGINE_CONFIG.FAA_LIMIT_AGL;

                    if (minSafeAlt > faaCeiling) {
                        continue;
                    }

                    const currPoint = grid.lanes[current.lane][current.step];
                    const dist = calculateDistance(currPoint, nextPoint);
                    const timeToTravel = dist / ENGINE_CONFIG.CRUISE_SPEED_MPS;

                    const targetAlt = minSafeAlt;
                    const currentAlt = current.alt;

                    let altCost = 0;
                    if (currentAlt < targetAlt) {
                        const altChange = targetAlt - currentAlt;
                        altCost = altChange * ENGINE_CONFIG.COST_CLIMB_PENALTY;
                    }

                    const laneChangeCost = Math.abs(nextLane - current.lane) * ENGINE_CONFIG.COST_LANE_CHANGE;

                    let proximityCost = 0;
                    const cruiseAlt = Math.max(currentAlt, targetAlt);

                    if (nextLane > 0) {
                        const leftNeighbor = grid.lanes[nextLane - 1][nextStep];
                        const leftMinSafe = Math.max(leftNeighbor.obstacleHeight, leftNeighbor.terrainHeight) + ENGINE_CONFIG.SAFETY_BUFFER_M;
                        if (leftMinSafe > cruiseAlt) {
                            proximityCost += ENGINE_CONFIG.COST_PROXIMITY_PENALTY;
                        }
                    }

                    if (nextLane < numLanes - 1) {
                        const rightNeighbor = grid.lanes[nextLane + 1][nextStep];
                        const rightMinSafe = Math.max(rightNeighbor.obstacleHeight, rightNeighbor.terrainHeight) + ENGINE_CONFIG.SAFETY_BUFFER_M;
                        if (rightMinSafe > cruiseAlt) {
                            proximityCost += ENGINE_CONFIG.COST_PROXIMITY_PENALTY;
                        }
                    }

                    const stepCost = timeToTravel + altCost + laneChangeCost + proximityCost;
                    const tentativeG = gScore[current.id] + stepCost;

                    if (tentativeG < (gScore[nextId] || Infinity)) {
                        cameFrom[nextId] = current;
                        gScore[nextId] = tentativeG;

                        const endPoint = grid.lanes[centerLaneIdx][numSteps - 1];
                        const distToEnd = calculateDistance(nextPoint, endPoint);
                        const hScore = distToEnd / ENGINE_CONFIG.CRUISE_SPEED_MPS;

                        const existing = openSet.find((node) => node.id === nextId);
                        if (existing) {
                            existing.gScore = tentativeG;
                            existing.fScore = tentativeG + hScore;
                            existing.alt = Math.max(current.alt, targetAlt);
                        } else {
                            const newAlt = Math.max(current.alt, targetAlt);
                            openSet.push({
                                id: nextId,
                                step: nextStep,
                                lane: nextLane,
                                gScore: tentativeG,
                                fScore: tentativeG + hScore,
                                alt: newAlt
                            });
                        }
                    }
                }
            }

            if (!finalNode) {
                console.log('[RouteEngine] A* failed: no path found');
                return {
                    success: false,
                    waypoints: [],
                    impossibleSegments: []
                };
            }

            const pathNodes = [];
            let curr = finalNode;
            while (curr) {
                pathNodes.push(curr);
                curr = cameFrom[curr.id];
            }
            pathNodes.reverse();

            console.log(`[RouteEngine] A* raw path: ${pathNodes.length} nodes. Visited: ${nodesVisited}`);

            const smoothedPath = smoothPath(pathNodes, grid);

            const finalWaypoints = [];
            const waypointIndices = grid.waypointIndices || [0, numSteps - 1];

            console.log(`[RouteEngine] User waypoint grid indices: ${waypointIndices.join(', ')}`);

            let maxCruiseAlt = 0;
            pathNodes.forEach((node) => {
                maxCruiseAlt = Math.max(maxCruiseAlt, node.alt);
            });

            for (let wpIdx = 0; wpIdx < waypointIndices.length; wpIdx += 1) {
                const stepIdx = waypointIndices[wpIdx];
                const point = grid.lanes[centerLaneIdx][stepIdx];
                const isFirst = wpIdx === 0;
                const isLast = wpIdx === waypointIndices.length - 1;

                finalWaypoints.push({
                    lat: point.lat,
                    lon: point.lon,
                    alt: point.terrainHeight,
                    phase: isFirst ? 'GROUND_START' : (isLast ? 'GROUND_END' : 'GROUND_WAYPOINT'),
                    prio: 1
                });

                if (!isLast) {
                    finalWaypoints.push({
                        lat: point.lat,
                        lon: point.lon,
                        alt: maxCruiseAlt,
                        phase: 'VERTICAL_ASCENT',
                        prio: 1
                    });

                    const nextStepIdx = waypointIndices[wpIdx + 1];
                    let lastOutputLane = centerLaneIdx;
                    let lastOutputNode = null;
                    let lastNodeBeforeLaneChange = null;
                    const maxSegmentDistance = 15;

                    for (let i = 0; i < smoothedPath.length; i += 1) {
                        const node = smoothedPath[i];
                        if (node.step > stepIdx && node.step < nextStepIdx) {
                            const nodePoint = grid.lanes[node.lane][node.step];

                            if (node.lane !== lastOutputLane) {
                                if (lastNodeBeforeLaneChange) {
                                    const prevPoint = grid.lanes[lastNodeBeforeLaneChange.lane][lastNodeBeforeLaneChange.step];
                                    finalWaypoints.push({
                                        lat: prevPoint.lat,
                                        lon: prevPoint.lon,
                                        alt: maxCruiseAlt,
                                        phase: 'CRUISE_CORNER',
                                        prio: 1
                                    });
                                    lastOutputNode = lastNodeBeforeLaneChange;
                                }

                                finalWaypoints.push({
                                    lat: nodePoint.lat,
                                    lon: nodePoint.lon,
                                    alt: maxCruiseAlt,
                                    phase: 'CRUISE',
                                    prio: 1
                                });
                                lastOutputLane = node.lane;
                                lastOutputNode = node;
                            } else if (lastOutputNode) {
                                const lastPoint = grid.lanes[lastOutputNode.lane][lastOutputNode.step];
                                const dist = calculateDistance(lastPoint, nodePoint);
                                if (dist > maxSegmentDistance) {
                                    finalWaypoints.push({
                                        lat: nodePoint.lat,
                                        lon: nodePoint.lon,
                                        alt: maxCruiseAlt,
                                        phase: 'CRUISE_INTERMEDIATE',
                                        prio: 1
                                    });
                                    lastOutputNode = node;
                                }
                            }

                            lastNodeBeforeLaneChange = node;
                        }
                    }

                    const nextPoint = grid.lanes[centerLaneIdx][nextStepIdx];
                    finalWaypoints.push({
                        lat: nextPoint.lat,
                        lon: nextPoint.lon,
                        alt: maxCruiseAlt,
                        phase: 'VERTICAL_DESCENT',
                        prio: 1
                    });
                }
            }

            const endTime = performance.now();
            console.log(`[RouteEngine] Optimization took ${(endTime - startTime).toFixed(1)}ms`);
            console.log(`[RouteEngine] Final waypoints: ${finalWaypoints.length}`);

            return {
                success: true,
                waypoints: finalWaypoints,
                optimizedPoints: finalWaypoints.length,
                nodesVisited,
                stats: {
                    avgAGL: maxCruiseAlt - grid.lanes[centerLaneIdx][0].terrainHeight,
                    maxAGL: maxCruiseAlt - grid.lanes[centerLaneIdx][0].terrainHeight,
                    maxAltitude: maxCruiseAlt
                },
                profileView: null
            };
        },

        validateAndFixSegments: async function (waypoints, viewer) {
            if (!viewer || waypoints.length < 2) return waypoints;

            console.log('[RouteEngine] Validating line segments for collisions');
            const checks = 5;
            const fixedWaypoints = [];

            for (let i = 0; i < waypoints.length; i += 1) {
                const wp = waypoints[i];
                fixedWaypoints.push(wp);

                if (i === waypoints.length - 1) continue;
                if (wp.phase === 'GROUND_START' || wp.phase === 'GROUND_WAYPOINT' || wp.phase === 'GROUND_END') continue;
                if (wp.phase === 'VERTICAL_ASCENT' || waypoints[i + 1].phase === 'VERTICAL_DESCENT') continue;

                const nextWp = waypoints[i + 1];
                const collisionPoints = [];
                const checkPositions = [];

                for (let j = 1; j < checks; j += 1) {
                    const t = j / checks;
                    const midLat = wp.lat + t * (nextWp.lat - wp.lat);
                    const midLon = wp.lon + t * (nextWp.lon - wp.lon);
                    checkPositions.push(Cesium.Cartesian3.fromDegrees(midLon, midLat, 1000));
                }

                try {
                    const clampedPositions = await viewer.scene.clampToHeightMostDetailed(
                        checkPositions,
                        [],
                        1.0
                    );

                    if (!clampedPositions || clampedPositions.length === 0) {
                        console.warn('[RouteEngine] No clamped positions returned for segment', i);
                        continue;
                    }

                    for (let j = 0; j < clampedPositions.length; j += 1) {
                        const clampedPos = clampedPositions[j];
                        if (!clampedPos) continue;

                        const carto = Cesium.Cartographic.fromCartesian(clampedPos);
                        if (!carto) continue;

                        const obstacleHeight = carto.height || 0;
                        const minSafeAlt = obstacleHeight + ENGINE_CONFIG.SAFETY_BUFFER_M;

                        if (minSafeAlt > wp.alt) {
                            const t = (j + 1) / checks;
                            const midLat = wp.lat + t * (nextWp.lat - wp.lat);
                            const midLon = wp.lon + t * (nextWp.lon - wp.lon);
                            collisionPoints.push({
                                lat: midLat,
                                lon: midLon,
                                alt: minSafeAlt + 10,
                                obstacleHeight: obstacleHeight,
                                phase: 'CRUISE_DETOUR',
                                prio: 1
                            });
                        }
                    }
                } catch (error) {
                    console.warn('[RouteEngine] Segment validation failed:', error);
                }

                if (collisionPoints.length > 0) {
                    console.log(`[RouteEngine] Segment ${i} collisions: ${collisionPoints.length}`);
                    fixedWaypoints.push(collisionPoints[0]);
                    if (collisionPoints.length > 1) {
                        fixedWaypoints.push(collisionPoints[collisionPoints.length - 1]);
                    }
                }
            }

            console.log(`[RouteEngine] Segment validation complete. ${waypoints.length} -> ${fixedWaypoints.length} waypoints`);
            return fixedWaypoints;
        }
    };

    root.RouteEngine = RouteEngine;
})(typeof window !== 'undefined' ? window : this);
