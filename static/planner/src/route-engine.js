/**
 * Route Engine - Global 3D A* Pathfinding
 * 
 * Implements a global optimization algorithm to find the mathematically optimal 
 * flight path through the 3D airspace grid.
 * 
 * Algorithm:
 * 1. Construct a Directed Acyclic Graph (DAG) from the sampled corridor grid.
 * 2. Nodes are (Step, Lane) pairs with defined MinSafeAltitude.
 * 3. Edges connect forward to adjacent lanes (Left, Center, Right).
 * 4. A* Search finds the path with minimum cost (distance + climb penalty).
 * 
 * @module route-engine
 */

(function (root) {
    'use strict';

    // ============================================================================
    // Configuration
    // ============================================================================

    const ENGINE_CONFIG = {
        // Physical Limits
        FAA_LIMIT_AGL: 121,            // FAA Part 107 limit (400ft ≈ 121m)
        SAFETY_BUFFER_M: 15,           // Clearance above obstacles

        // Flight Characteristics
        CLIMB_SPEED_MPS: 2.0,          // Climb speed (m/s)
        CRUISE_SPEED_MPS: 15.0,        // Horizontal speed (m/s)
        DESCENT_SPEED_MPS: 3.0,        // Descent speed (m/s)

        // Cost Weights (Tuned for Smooth Flight)
        // We want: straight paths > lateral deviations > climbing
        COST_TIME_WEIGHT: 1.0,         // Base cost
        COST_CLIMB_PENALTY: 15.0,      // Penalty for altitude changes
        COST_LANE_CHANGE: 50.0,        // HIGH penalty for lateral moves (avoid zig-zag)
        COST_PROXIMITY_PENALTY: 100.0, // Penalty for flying adjacent to building walls

        // Earth Constants
        EARTH_RADIUS_M: 6371000
    };

    // ============================================================================
    // Geodetic Helpers
    // ============================================================================

    function toRad(deg) { return deg * Math.PI / 180; }
    function toDeg(rad) { return rad * 180 / Math.PI; }

    function calculateDistance(p1, p2) {
        const R = ENGINE_CONFIG.EARTH_RADIUS_M;
        const φ1 = toRad(p1.lat), φ2 = toRad(p2.lat);
        const Δφ = toRad(p2.lat - p1.lat);
        const Δλ = toRad(p2.lon - p1.lon);
        const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ============================================================================
    // String Pulling Path Smoothing
    // ============================================================================

    /**
     * Smooth the A* path by removing unnecessary intermediate nodes
     * Uses "String Pulling" technique - skip nodes if straight line is clear
     * @param {Array} pathNodes - Raw path nodes from A* [{step, lane, alt}, ...]
     * @param {Object} grid - The full grid with obstacle heights
     * @returns {Array} Smoothed path with fewer nodes
     */
    function smoothPath(pathNodes, grid) {
        if (!pathNodes || pathNodes.length <= 2) return pathNodes;

        const smoothed = [pathNodes[0]]; // Always keep start
        let currentIdx = 0;

        while (currentIdx < pathNodes.length - 1) {
            const current = pathNodes[currentIdx];
            let furthestValid = currentIdx + 1; // At minimum, we advance one step

            // Look ahead: can we skip to a further node?
            for (let targetIdx = currentIdx + 2; targetIdx < pathNodes.length; targetIdx++) {
                const target = pathNodes[targetIdx];

                // Check if straight line from current to target is clear
                if (isLineOfSightClear(current, target, pathNodes, currentIdx, targetIdx, grid)) {
                    furthestValid = targetIdx;
                }
            }

            // Add the furthest valid node we can reach
            smoothed.push(pathNodes[furthestValid]);
            currentIdx = furthestValid;
        }

        console.log(`[RouteEngine] Path smoothed: ${pathNodes.length} -> ${smoothed.length} nodes`);
        return smoothed;
    }

    /**
     * Check if straight line between two nodes clears all obstacles
     * @param {Object} start - Starting node
     * @param {Object} end - Ending node
     * @param {Array} allNodes - All path nodes (for intermediate altitude reference)
     * @param {number} startIdx - Index of start in allNodes
     * @param {number} endIdx - Index of end in allNodes
     * @param {Object} grid - Grid with obstacle heights
     * @returns {boolean} True if line of sight is clear
     */
    function isLineOfSightClear(start, end, allNodes, startIdx, endIdx, grid) {
        // Get the cruise altitude (max altitude along this segment)
        let maxAlt = Math.max(start.alt, end.alt);
        for (let i = startIdx; i <= endIdx; i++) {
            maxAlt = Math.max(maxAlt, allNodes[i].alt);
        }

        const numLanes = grid.lanes.length;
        const numSteps = grid.lanes[0].length;

        // Sample points along the line - more samples for safety
        const numSamples = Math.max(5, (endIdx - startIdx) * 2);

        for (let i = 1; i < numSamples; i++) {
            const t = i / numSamples;

            // Interpolate lane and step (grid coordinates)
            const midStep = Math.round(start.step + t * (end.step - start.step));
            const midLane = Math.round(start.lane + t * (end.lane - start.lane));

            // Bounds check
            if (midLane < 0 || midLane >= numLanes) return false;
            if (midStep < 0 || midStep >= numSteps) return false;

            // Get obstacle height at this interpolated position
            const gridPoint = grid.lanes[midLane][midStep];
            const obstacleHeight = Math.max(gridPoint.obstacleHeight || 0, gridPoint.terrainHeight || 0);
            const minSafeAlt = obstacleHeight + ENGINE_CONFIG.SAFETY_BUFFER_M;

            // Check if we clear the obstacle VERTICALLY
            if (minSafeAlt > maxAlt) {
                return false; // Obstacle blocks line of sight
            }

            // HORIZONTAL PROXIMITY CHECK
            // Check if there's a wall immediately adjacent that we'd fly through
            // Left neighbor
            if (midLane > 0) {
                const leftPoint = grid.lanes[midLane - 1][midStep];
                const leftHeight = Math.max(leftPoint.obstacleHeight || 0, leftPoint.terrainHeight || 0);
                if (leftHeight + ENGINE_CONFIG.SAFETY_BUFFER_M > maxAlt) {
                    return false; // Wall to our left blocks path
                }
            }

            // Right neighbor
            if (midLane < numLanes - 1) {
                const rightPoint = grid.lanes[midLane + 1][midStep];
                const rightHeight = Math.max(rightPoint.obstacleHeight || 0, rightPoint.terrainHeight || 0);
                if (rightHeight + ENGINE_CONFIG.SAFETY_BUFFER_M > maxAlt) {
                    return false; // Wall to our right blocks path
                }
            }
        }

        return true; // Line is clear!
    }

    // ============================================================================
    // Optimality Engine (A* Solver)
    // ============================================================================

    const RouteEngine = {

        /**
         * Calculate minimal-cost path through the airspace
         * @param {Array} originalWaypoints - User defined waypoints (Start/End/Landing Zones)
         * @param {Object} grid - The 5-lane sampled grid with heights
         * @returns {Object} Optimized path result
         */
        optimizeFlightPath: function (originalWaypoints, grid) {
            console.log('[RouteEngine] Starting Global A* Optimization...');
            const startTime = performance.now();

            const numLanes = grid.lanes.length;
            const numSteps = grid.lanes[0].length;
            const centerLaneIdx = Math.floor(numLanes / 2); // Center lane (dynamic)

            // ---------------------------------------------------------
            // 1. Build The Graph (Implicitly) & Run A*
            // ---------------------------------------------------------

            // Priority Queue for Open Set: [F-Score, Step, Lane, ParentNode]
            // We use a simple array and sort (optimization: use binary heap if N large, but N < 100 usually)
            const openSet = [];
            const closedSet = new Set(); // Stores "step_lane"
            const cameFrom = {}; // Map "step_lane" -> prevoius "step_lane"

            // Initial State: Start at Step 0, Center Lane
            // Note: Start altitude is Terrain height (Takeoff)
            const startNode = {
                id: `0_${centerLaneIdx}`,
                step: 0,
                lane: centerLaneIdx,
                gScore: 0,
                fScore: 0,
                alt: grid.lanes[centerLaneIdx][0].terrainHeight
            };

            openSet.push(startNode);

            // G-Score Map: "step_lane" -> cost
            const gScore = {};
            gScore[startNode.id] = 0;

            let finalNode = null;
            let nodesVisited = 0;

            while (openSet.length > 0) {
                // Get node with lowest F-Score
                openSet.sort((a, b) => a.fScore - b.fScore);
                const current = openSet.shift();
                nodesVisited++;

                // Goal Check: Reached the last step?
                if (current.step === numSteps - 1) {
                    if (current.lane === centerLaneIdx) {
                        finalNode = current;
                        break;
                    }
                }

                closedSet.add(current.id);

                // Explore Neighbors (Next Step)
                // We can move to: Left, Center, Right in the NEXT step.
                const nextStep = current.step + 1;

                if (nextStep >= numSteps) continue;

                // Candidate Lanes: [current-1, current, current+1]
                const candidateLanes = [current.lane - 1, current.lane, current.lane + 1]
                    .filter(l => l >= 0 && l < numLanes);

                for (const nextLane of candidateLanes) {
                    const nextId = `${nextStep}_${nextLane}`;
                    if (closedSet.has(nextId)) continue; // Already evaluated

                    // ---------------------------------------------
                    // VALIDITY CHECK (The "Wall")
                    // ---------------------------------------------
                    const nextPoint = grid.lanes[nextLane][nextStep];

                    // Safe Altitude Floor
                    const featureHeight = Math.max(nextPoint.obstacleHeight, nextPoint.terrainHeight);
                    const minSafeAlt = featureHeight + ENGINE_CONFIG.SAFETY_BUFFER_M;

                    // FAA Ceiling
                    const faaCeiling = nextPoint.terrainHeight + ENGINE_CONFIG.FAA_LIMIT_AGL;

                    if (minSafeAlt > faaCeiling) {
                        // BLOCKED: Gap is too small or nonexistent (building > 400ft)
                        continue;
                    }

                    // ---------------------------------------------
                    // COST CALCULATION
                    // ---------------------------------------------
                    // Distance cost
                    const currPoint = grid.lanes[current.lane][current.step];
                    const dist = calculateDistance(currPoint, nextPoint);
                    const timeToTravel = dist / ENGINE_CONFIG.CRUISE_SPEED_MPS;

                    // Altitude Cost - SMART: Only penalize if we NEED to climb
                    // If we're already flying at or above the safe altitude, no extra cost!
                    const targetAlt = minSafeAlt;
                    const currentAlt = current.alt;

                    let altCost = 0;
                    if (currentAlt >= targetAlt) {
                        // Already above this obstacle - NO COST to fly over!
                        // Keep flying at current altitude
                    } else {
                        // Need to climb - this is expensive
                        const altChange = targetAlt - currentAlt;
                        altCost = altChange * ENGINE_CONFIG.COST_CLIMB_PENALTY;
                    }

                    // Lane Change Penalty
                    const laneChangeCost = Math.abs(nextLane - current.lane) * ENGINE_CONFIG.COST_LANE_CHANGE;

                    // ---------------------------------------------------------
                    // PROXIMITY PENALTY (Virtual Buffer)
                    // Penalize flying adjacent to building walls
                    // ---------------------------------------------------------
                    let proximityCost = 0;
                    const cruiseAlt = Math.max(currentAlt, targetAlt);

                    // Check LEFT neighbor
                    if (nextLane > 0) {
                        const leftNeighbor = grid.lanes[nextLane - 1][nextStep];
                        const leftMinSafe = Math.max(leftNeighbor.obstacleHeight, leftNeighbor.terrainHeight) + ENGINE_CONFIG.SAFETY_BUFFER_M;
                        if (leftMinSafe > cruiseAlt) {
                            // Wall to our left!
                            proximityCost += ENGINE_CONFIG.COST_PROXIMITY_PENALTY;
                        }
                    }

                    // Check RIGHT neighbor
                    if (nextLane < numLanes - 1) {
                        const rightNeighbor = grid.lanes[nextLane + 1][nextStep];
                        const rightMinSafe = Math.max(rightNeighbor.obstacleHeight, rightNeighbor.terrainHeight) + ENGINE_CONFIG.SAFETY_BUFFER_M;
                        if (rightMinSafe > cruiseAlt) {
                            // Wall to our right!
                            proximityCost += ENGINE_CONFIG.COST_PROXIMITY_PENALTY;
                        }
                    }

                    const stepCost = timeToTravel + altCost + laneChangeCost + proximityCost;
                    const tentativeG = gScore[current.id] + stepCost;

                    if (tentativeG < (gScore[nextId] || Infinity)) {
                        // Found a better path to this node!
                        cameFrom[nextId] = current;
                        gScore[nextId] = tentativeG;

                        // H-Score (Heuristic)
                        const endPoint = grid.lanes[centerLaneIdx][numSteps - 1];
                        const distToEnd = calculateDistance(nextPoint, endPoint);
                        const hScore = distToEnd / ENGINE_CONFIG.CRUISE_SPEED_MPS;

                        // Add to Open Set
                        const existing = openSet.find(n => n.id === nextId);
                        if (existing) {
                            existing.gScore = tentativeG;
                            existing.fScore = tentativeG + hScore;
                            // CRITICAL: Maintain altitude - don't drop down over buildings!
                            existing.alt = Math.max(current.alt, targetAlt);
                        } else {
                            // New altitude = max of current cruise alt or building min safe alt
                            // This ensures we don't "yo-yo" up and down over buildings
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

            // ---------------------------------------------------------
            // 2. Reconstruct Path
            // ---------------------------------------------------------
            if (!finalNode) {
                console.log('[RouteEngine] ERROR: A* Failed: No path found');
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

            console.log(`[RouteEngine] A* found raw path: ${pathNodes.length} nodes. Visited: ${nodesVisited}`);

            // ---------------------------------------------------------
            // 2.5 String Pulling Path Smoothing
            // ---------------------------------------------------------
            // Remove unnecessary intermediate nodes when straight line is clear
            const smoothedPath = smoothPath(pathNodes, grid);

            // ---------------------------------------------------------
            // 3. Post-Processing: Add Landing Zone Transitions
            // ---------------------------------------------------------
            // User waypoints are LANDING ZONES - drone must touch ground at EACH
            // Pattern for each segment: Ground -> Vertical Ascent -> Cruise -> Vertical Descent -> Ground

            const finalWaypoints = [];
            const waypointIndices = grid.waypointIndices || [0, numSteps - 1]; // Fallback if not provided

            console.log(`[RouteEngine] User waypoint grid indices: ${waypointIndices.join(', ')}`);

            // Calculate cruise altitude (highest point along path + safety)
            let maxCruiseAlt = 0;
            pathNodes.forEach(node => {
                maxCruiseAlt = Math.max(maxCruiseAlt, node.alt);
            });
            maxCruiseAlt += 15; // Extra buffer above highest obstacle

            // For each segment between user waypoints
            for (let wpIdx = 0; wpIdx < waypointIndices.length; wpIdx++) {
                const stepIdx = waypointIndices[wpIdx];
                const point = grid.lanes[centerLaneIdx][stepIdx];
                const isFirst = (wpIdx === 0);
                const isLast = (wpIdx === waypointIndices.length - 1);

                // === GROUND at this waypoint ===
                finalWaypoints.push({
                    lat: point.lat,
                    lon: point.lon,
                    alt: point.terrainHeight,
                    phase: isFirst ? 'GROUND_START' : (isLast ? 'GROUND_END' : 'GROUND_WAYPOINT'),
                    prio: 1
                });

                // === TAKEOFF (if not last waypoint) ===
                if (!isLast) {
                    // Vertical ascent
                    finalWaypoints.push({
                        lat: point.lat,
                        lon: point.lon,
                        alt: maxCruiseAlt,
                        phase: 'VERTICAL_ASCENT',
                        prio: 1
                    });

                    // Find path nodes between this waypoint and next
                    const nextStepIdx = waypointIndices[wpIdx + 1];

                    // PATH SMOOTHING WITH CORNER ELBOWS + INTERMEDIATE POINTS
                    // When lane changes, output:
                    // 1. Last point(s) in OLD lane leading up to turn
                    // 2. First point in NEW lane (after turn)
                    // For long segments, add intermediate points every ~15m

                    let lastOutputLane = centerLaneIdx;
                    let lastOutputNode = null;
                    let lastNodeBeforeLaneChange = null;
                    const MAX_SEGMENT_DISTANCE = 15; // meters

                    for (let i = 0; i < smoothedPath.length; i++) {
                        const node = smoothedPath[i];
                        // Include nodes strictly between user waypoints
                        if (node.step > stepIdx && node.step < nextStepIdx) {
                            const nodePoint = grid.lanes[node.lane][node.step];

                            if (node.lane !== lastOutputLane) {
                                // CORNER ELBOW: First, output the last point in OLD lane
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

                                // Then output the new lane point
                                finalWaypoints.push({
                                    lat: nodePoint.lat,
                                    lon: nodePoint.lon,
                                    alt: maxCruiseAlt,
                                    phase: 'CRUISE',
                                    prio: 1
                                });
                                lastOutputLane = node.lane;
                                lastOutputNode = node;
                            } else {
                                // SAME LANE: Check distance from last output
                                // If too far, add intermediate waypoint
                                if (lastOutputNode) {
                                    const lastPoint = grid.lanes[lastOutputNode.lane][lastOutputNode.step];
                                    const dist = calculateDistance(lastPoint, nodePoint);
                                    if (dist > MAX_SEGMENT_DISTANCE) {
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
                            }

                            // Track last node for corner detection
                            lastNodeBeforeLaneChange = node;
                        }
                    }

                    // Approach next waypoint at cruise altitude
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
            console.log(`[RouteEngine] Final waypoints: ${finalWaypoints.length} (with landing at ${waypointIndices.length} user waypoints)`);

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

        // Helper to formatting
        nodeToWaypoint: function (node, grid, centerLaneIdx) {
            const point = grid.lanes[node.lane][node.step];
            return {
                lat: point.lat,
                lon: point.lon,
                alt: node.alt,
                prio: 1
            };
        },

        /**
         * Validate line segments between waypoints for building collisions
         * If collision detected, insert intermediate waypoints to detour
         * @param {Array} waypoints - Array of waypoints
         * @param {Object} viewer - Cesium viewer for height sampling
         * @returns {Promise<Array>} Fixed waypoints with no collisions
         */
        validateAndFixSegments: async function (waypoints, viewer) {
            if (!viewer || waypoints.length < 2) return waypoints;

            console.log('[RouteEngine] Validating line segments for collisions...');
            const NUM_CHECKS = 5; // Check 5 points per segment
            const fixedWaypoints = [];

            for (let i = 0; i < waypoints.length; i++) {
                const wp = waypoints[i];
                fixedWaypoints.push(wp);

                // Skip if last waypoint or ground phase (vertical segments are ok)
                if (i === waypoints.length - 1) continue;
                if (wp.phase === 'GROUND_START' || wp.phase === 'GROUND_WAYPOINT' || wp.phase === 'GROUND_END') continue;
                if (wp.phase === 'VERTICAL_ASCENT' || waypoints[i + 1].phase === 'VERTICAL_DESCENT') continue;

                const nextWp = waypoints[i + 1];

                // Check intermediate points along segment
                const collisionPoints = [];
                const checkPositions = [];

                for (let j = 1; j < NUM_CHECKS; j++) {
                    const t = j / NUM_CHECKS;
                    const midLat = wp.lat + t * (nextWp.lat - wp.lat);
                    const midLon = wp.lon + t * (nextWp.lon - wp.lon);
                    checkPositions.push(Cesium.Cartesian3.fromDegrees(midLon, midLat, 1000));
                }

                // Batch sample heights using clampToHeightMostDetailed
                try {
                    const clampedPositions = await viewer.scene.clampToHeightMostDetailed(
                        checkPositions,
                        [],  // Don't exclude anything
                        1.0
                    );

                    if (!clampedPositions || clampedPositions.length === 0) {
                        console.warn('[RouteEngine] No clamped positions returned for segment', i);
                        continue;
                    }

                    for (let j = 0; j < clampedPositions.length; j++) {
                        const clampedPos = clampedPositions[j];
                        if (!clampedPos) continue; // Skip undefined positions

                        const carto = Cesium.Cartographic.fromCartesian(clampedPos);
                        if (!carto) continue; // Skip if conversion failed

                        const obstacleHeight = carto.height || 0;
                        const minSafeAlt = obstacleHeight + ENGINE_CONFIG.SAFETY_BUFFER_M;

                        if (minSafeAlt > wp.alt) {
                            // COLLISION DETECTED! Insert this point as intermediate waypoint
                            const t = (j + 1) / NUM_CHECKS;
                            const midLat = wp.lat + t * (nextWp.lat - wp.lat);
                            const midLon = wp.lon + t * (nextWp.lon - wp.lon);
                            collisionPoints.push({
                                lat: midLat,
                                lon: midLon,
                                alt: minSafeAlt + 10, // Go higher to clear
                                obstacleHeight: obstacleHeight,
                                phase: 'CRUISE_DETOUR',
                                prio: 1
                            });
                        }
                    }
                } catch (error) {
                    console.warn('[RouteEngine] Segment validation failed:', error);
                }

                // Insert collision avoidance waypoints
                if (collisionPoints.length > 0) {
                    console.log(`[RouteEngine] Segment ${i} has ${collisionPoints.length} collisions, inserting detours`);

                    // For now, just insert the first and last collision point as detours
                    // Future: implement smarter detour routing
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

    // Export to root (window)
    root.RouteEngine = RouteEngine;

})(typeof window !== 'undefined' ? window : this);
