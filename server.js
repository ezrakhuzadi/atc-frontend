(async function () {
  "use strict";
  /*jshint node:true*/

  const express = require("express");
  const session = require("express-session");
  const crypto = require("crypto");
  const path = require("path");
  const fs = require("fs");
  const bcrypt = require("bcryptjs");
  const axios = require("axios");
  const net = require("net");
  const tls = require("tls");
  const { initUserStore } = require("./util/user-store");
  const { requireAuth, requireRole } = require("./util/auth");
  require("dotenv").config();

  const controlRouter = require("./routes/control");
  const FileStore = require("session-file-store")(session);

  const BLENDER_URL = process.env.BLENDER_URL || process.env.BLENDER_BASE_URL || "http://localhost:8000";
  const ATC_URL = process.env.ATC_SERVER_URL || "http://localhost:3000";
  const ATC_PROXY_BASE = process.env.ATC_PROXY_BASE || "/api/atc";
  const ATC_WS_URL = process.env.ATC_WS_URL || "";
  const ATC_WS_TOKEN = process.env.ATC_WS_TOKEN || "";
  const ATC_ADMIN_TOKEN = process.env.ATC_ADMIN_TOKEN || "";
  const ATC_REGISTRATION_TOKEN = process.env.ATC_REGISTRATION_TOKEN || "";
  const BLENDER_AUDIENCE = process.env.PASSPORT_AUDIENCE || "testflight.flightblender.com";
  const BLENDER_AUTH_TOKEN = process.env.BLENDER_AUTH_TOKEN || "";
  const IS_PRODUCTION = process.env.NODE_ENV === "production";
  const DEMO_MODE = process.env.DEMO_MODE === "1";
  const PASSWORD_ALGO = "bcrypt";
  const PASSWORD_ROUNDS = Number(process.env.PASSWORD_ROUNDS || 10);
  const ALLOW_DEFAULT_USERS = process.env.ATC_ALLOW_DEFAULT_USERS === "1";
  const CESIUM_ION_TOKEN = process.env.CESIUM_ION_TOKEN || "";
  const GOOGLE_3D_TILES_ASSET_ID = Number(process.env.GOOGLE_3D_TILES_ASSET_ID);
  const OSM_BUILDINGS_ASSET_ID = Number(process.env.OSM_BUILDINGS_ASSET_ID);
  const ROUTE_ENGINE_CONFIG = parseJsonConfig(process.env.ATC_ROUTE_ENGINE_CONFIG, "ATC_ROUTE_ENGINE_CONFIG");
  const ROUTE_PLANNER_CONFIG = parseJsonConfig(process.env.ATC_ROUTE_PLANNER_CONFIG, "ATC_ROUTE_PLANNER_CONFIG");

  const DEFAULT_COMPLIANCE_LIMITS = {
    maxWindMps: 12,
    maxGustMps: 15,
    maxPrecipMm: 2,
    windWarnRatio: 0.8,
    batteryWarnMarginMin: 5,
    populationBvlosMax: 1500,
    populationWarn: 2000,
    populationAbsoluteMax: 4000,
    defaultClearanceM: 60
  };
  let COMPLIANCE_LIMITS = { ...DEFAULT_COMPLIANCE_LIMITS };
  const COMPLIANCE_LIMITS_REFRESH_MS = 5 * 60 * 1000;
  let complianceLimitsLastFetched = 0;

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeComplianceLimits(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      maxWindMps: toNumber(payload.maxWindMps) ?? DEFAULT_COMPLIANCE_LIMITS.maxWindMps,
      maxGustMps: toNumber(payload.maxGustMps) ?? DEFAULT_COMPLIANCE_LIMITS.maxGustMps,
      maxPrecipMm: toNumber(payload.maxPrecipMm) ?? DEFAULT_COMPLIANCE_LIMITS.maxPrecipMm,
      windWarnRatio: toNumber(payload.windWarnRatio) ?? DEFAULT_COMPLIANCE_LIMITS.windWarnRatio,
      batteryWarnMarginMin: toNumber(payload.batteryWarnMarginMin) ?? DEFAULT_COMPLIANCE_LIMITS.batteryWarnMarginMin,
      populationBvlosMax: toNumber(payload.populationBvlosMax) ?? DEFAULT_COMPLIANCE_LIMITS.populationBvlosMax,
      populationWarn: toNumber(payload.populationWarn) ?? DEFAULT_COMPLIANCE_LIMITS.populationWarn,
      populationAbsoluteMax: toNumber(payload.populationAbsoluteMax) ?? DEFAULT_COMPLIANCE_LIMITS.populationAbsoluteMax,
      defaultClearanceM: toNumber(payload.defaultClearanceM) ?? DEFAULT_COMPLIANCE_LIMITS.defaultClearanceM
    };
  }

  async function refreshComplianceLimits(force = false) {
    const now = Date.now();
    if (!force && now - complianceLimitsLastFetched < COMPLIANCE_LIMITS_REFRESH_MS) {
      return COMPLIANCE_LIMITS;
    }
    try {
      const response = await axios.get(`${ATC_URL}/v1/compliance/limits`, {
        timeout: 2500,
        validateStatus: () => true
      });
      if (response.status === 200) {
        const normalized = normalizeComplianceLimits(response.data);
        if (normalized) {
          COMPLIANCE_LIMITS = normalized;
          complianceLimitsLastFetched = now;
        }
      }
    } catch (error) {
      if (force) {
        console.warn("[Compliance] Failed to sync limits from ATC:", error.message);
      }
    }
    return COMPLIANCE_LIMITS;
  }

  // Hash password helper
  function hashPassword(password) {
    return bcrypt.hashSync(password, PASSWORD_ROUNDS);
  }

  function hashLegacyPassword(password) {
    return crypto.createHash("sha256").update(password).digest("hex");
  }

  function verifyPassword(user, password) {
    if (!user || !password) return false;
    const algo = user.passwordAlgo || "sha256";
    if (algo === PASSWORD_ALGO) {
      return bcrypt.compareSync(password, user.passwordHash);
    }
    const legacyHash = hashLegacyPassword(password);
    if (legacyHash !== user.passwordHash) {
      return false;
    }
    const upgraded = hashPassword(password);
    userStore.updatePassword(user.id, upgraded, PASSWORD_ALGO);
    user.passwordHash = upgraded;
    user.passwordAlgo = PASSWORD_ALGO;
    return true;
  }

  function cleanEnv(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function parseJsonConfig(value, label) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      console.warn(`[CONFIG] ${label} is not valid JSON:`, error.message);
      return null;
    }
  }

  function buildSeedUser(prefix, fallback) {
    const email = cleanEnv(process.env[`${prefix}_EMAIL`]);
    const password = cleanEnv(process.env[`${prefix}_PASSWORD`]);
    const hasExplicit = Boolean(email && password);

    if (!hasExplicit && !ALLOW_DEFAULT_USERS) {
      return null;
    }

    if (!hasExplicit) {
      return fallback;
    }

    const id = cleanEnv(process.env[`${prefix}_ID`]) || email.split("@")[0];
    const name = cleanEnv(process.env[`${prefix}_NAME`]) || fallback.name;
    const role = cleanEnv(process.env[`${prefix}_ROLE`]) || fallback.role;

    if (!id) {
      console.warn(`[AUTH] ${prefix}_ID missing; cannot seed user.`);
      return null;
    }

    return {
      id,
      name,
      email,
      password,
      role
    };
  }

  function base64UrlEncode(value) {
    return Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  function createDevJwt(scopes) {
    if (BLENDER_AUTH_TOKEN) return BLENDER_AUTH_TOKEN;
    if (IS_PRODUCTION) {
      console.error("[AUTH] BLENDER_AUTH_TOKEN missing; refusing to create a dummy token in production.");
      return null;
    }
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: "dummy",
      aud: BLENDER_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 120,
      scope: scopes.join(" ")
    };
    const signature = Buffer.from("signature")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return `${base64UrlEncode(header)}.${base64UrlEncode(payload)}.${signature}`;
  }

  function ensureBlenderToken(scopes, res) {
    const token = createDevJwt(scopes);
    if (!token) {
      res.status(500).json({ message: "BLENDER_AUTH_TOKEN is required in production." });
      return null;
    }
    return token;
  }

  function buildDemoRidPayload(center, subscriptionId) {
    const testId = typeof subscriptionId === "string" && subscriptionId ? subscriptionId : crypto.randomUUID();
    const injectionId = crypto.randomUUID();
    const baseLat = Number.isFinite(center?.lat) ? center.lat : 33.6846;
    const baseLon = Number.isFinite(center?.lon) ? center.lon : -117.8265;
    const now = Date.now();
    const offsets = [
      [0, 0],
      [0.0015, 0.001],
      [0.003, 0.0018],
      [0.0045, 0.0022],
      [0.006, 0.0028]
    ];

    const telemetry = offsets.map((offset, index) => ({
      timestamp: new Date(now + index * 1000).toISOString(),
      timestamp_accuracy: 0,
      operational_status: "Airborne",
      position: {
        lat: baseLat + offset[0],
        lng: baseLon + offset[1],
        alt: 120,
        accuracy_h: "HAUnknown",
        accuracy_v: "VAUnknown",
        extrapolated: false,
        pressure_altitude: 0
      },
      height: { distance: 50, reference: "TakeoffLocation" },
      track: 90,
      speed: 8,
      speed_accuracy: "SAUnknown",
      vertical_speed: 0
    }));

    const payload = {
      requested_flights: [
        {
          injection_id: injectionId,
          aircraft_type: "UAS",
          telemetry,
          details_responses: [
            {
              effective_after: new Date(now).toISOString(),
              details: {
                id: injectionId,
                operator_id: "demo-operator",
                operator_location: { lat: baseLat, lng: baseLon },
                operation_description: "Demo Remote ID traffic",
                serial_number: injectionId,
                registration_number: `DEMO-${injectionId.slice(0, 8)}`
              }
            }
          ]
        }
      ]
    };

    return { testId, injectionId, payload };
  }

  const userStore = initUserStore();
  await refreshComplianceLimits(true);
  setInterval(() => {
    refreshComplianceLimits().catch((error) => {
      console.warn("[Compliance] Limit refresh failed:", error.message);
    });
  }, COMPLIANCE_LIMITS_REFRESH_MS).unref();

  const seedUsers = [];
  const adminSeed = buildSeedUser("ATC_BOOTSTRAP_ADMIN", {
    id: "admin",
    name: "Admin",
    email: "admin@example.com",
    password: "admin123",
    role: "admin"
  });
  if (adminSeed) seedUsers.push(adminSeed);

  const guestSeed = buildSeedUser("ATC_BOOTSTRAP_GUEST", {
    id: "guest",
    name: "Guest",
    email: "guest@example.com",
    password: "guest123",
    role: "viewer"
  });
  if (guestSeed) seedUsers.push(guestSeed);

  if (seedUsers.length === 0 && !ALLOW_DEFAULT_USERS) {
    console.warn("[AUTH] No bootstrap users configured; set ATC_BOOTSTRAP_ADMIN_EMAIL and ATC_BOOTSTRAP_ADMIN_PASSWORD.");
  } else if (ALLOW_DEFAULT_USERS) {
    console.warn("[AUTH] ATC_ALLOW_DEFAULT_USERS enabled; default accounts are seeded for dev only.");
  }

  userStore.ensureDefaults(hashPassword, PASSWORD_ALGO, seedUsers);

  let app = express();

  // Provide defaults even if a render bypasses res.locals middleware.
  app.locals.routeEngineConfig = ROUTE_ENGINE_CONFIG || {};
  app.locals.routePlannerConfig = ROUTE_PLANNER_CONFIG || {};

  app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.set("view engine", "ejs");
  app.use(express.static(__dirname + "/views"));
  app.use("/assets", express.static("static"));

  // Session middleware
  const sessionPath = process.env.SESSION_STORE_PATH || path.join(__dirname, "data", "sessions");
  fs.mkdirSync(sessionPath, { recursive: true });
  const rawSessionSecret = cleanEnv(process.env.SESSION_SECRET);
  if (!rawSessionSecret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production.");
  }
  const sessionSecret = rawSessionSecret || crypto.randomBytes(32).toString("hex");

  const sessionMiddleware = session({
    store: new FileStore({
      path: sessionPath,
      logFn: () => { }
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  });
  app.use(sessionMiddleware);

  // Make user available to all views
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.atcApiBase = ATC_PROXY_BASE;
    // Always use a same-origin WS proxy so browsers don't need Docker-internal DNS.
    res.locals.atcWsBase = ATC_PROXY_BASE;
    // Keep the server-side WS token out of the browser; the proxy injects it upstream.
    res.locals.atcWsToken = "";
    res.locals.demoMode = DEMO_MODE;
    res.locals.cesiumIonToken = CESIUM_ION_TOKEN;
    res.locals.complianceLimits = COMPLIANCE_LIMITS;
    res.locals.routeEngineConfig = ROUTE_ENGINE_CONFIG || {};
    res.locals.routePlannerConfig = ROUTE_PLANNER_CONFIG || {};
    res.locals.google3dTilesAssetId = Number.isFinite(GOOGLE_3D_TILES_ASSET_ID)
      ? GOOGLE_3D_TILES_ASSET_ID
      : null;
    res.locals.osmBuildingsAssetId = Number.isFinite(OSM_BUILDINGS_ASSET_ID)
      ? OSM_BUILDINGS_ASSET_ID
      : null;
    next();
  });

  // ========================================
  // Auth Routes
  // ========================================

  // Login page
  app.get('/login', (req, res) => {
    if (req.session.user) {
      return res.redirect('/control');
    }
    res.render('login', { error: null });
  });

  // Login form submission
  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = userStore.getUserById(username);
    if (user && verifyPassword(user, password)) {
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      };
      userStore.touchLogin(user.id);
      console.log(`[AUTH] User logged in: ${user.id}`);
      return res.redirect('/control');
    }

    res.render('login', { error: 'Invalid username or password' });
  });

  // Guest login (one-click)
  app.post('/login/guest', (req, res) => {
    const guest = userStore.getUserById('guest');
    req.session.user = {
      id: guest.id,
      name: guest.name,
      email: guest.email,
      role: guest.role,
      createdAt: guest.createdAt
    };
    userStore.touchLogin(guest.id);
    console.log('[AUTH] Guest user logged in');
    res.redirect('/control');
  });

  // Signup page
  app.get('/signup', (req, res) => {
    if (req.session.user) {
      return res.redirect('/control');
    }
    res.render('signup', { error: null, success: null });
  });

  // Signup form submission
  app.post('/signup', (req, res) => {
    const { username, email, password, confirmPassword, name } = req.body;

    // Validation
    if (!username || !email || !password || !name) {
      return res.render('signup', {
        error: 'All fields are required',
        success: null
      });
    }

    if (password.length < 6) {
      return res.render('signup', {
        error: 'Password must be at least 6 characters',
        success: null
      });
    }

    if (password !== confirmPassword) {
      return res.render('signup', {
        error: 'Passwords do not match',
        success: null
      });
    }

    if (userStore.getUserById(username)) {
      return res.render('signup', {
        error: 'Username already exists',
        success: null
      });
    }

    // Check email uniqueness
    if (userStore.getUserByEmail(email)) {
      return res.render('signup', {
        error: 'Email already registered',
        success: null
      });
    }

    // Create user
    const newUser = userStore.createUser({
      id: username,
      name: name,
      email: email,
      passwordHash: hashPassword(password),
      passwordAlgo: PASSWORD_ALGO,
      role: 'operator',
    });
    console.log(`[AUTH] New user registered: ${username}`);

    // Auto-login after signup
    req.session.user = {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      createdAt: newUser.createdAt
    };
    res.redirect('/control');
  });

  // Logout  
  app.get('/logout', (req, res) => {
    const userId = req.session.user?.id;
    req.session.destroy((err) => {
      if (err) console.error('[AUTH] Logout error:', err);
      console.log(`[AUTH] User logged out: ${userId}`);
      res.redirect('/login');
    });
  });

  // ========================================
  // Profile update routes
  // ========================================
  app.post('/account/update-profile', requireAuth, (req, res) => {
    const { name, email } = req.body;
    const userId = req.session.user.id;
    const user = userStore.getUserById(userId);

    if (!user) {
      return res.redirect('/control/settings?error=user_not_found');
    }

    const existingEmailUser = userStore.getUserByEmail(email);
    if (existingEmailUser && existingEmailUser.id !== userId) {
      return res.redirect('/control/settings?error=email_taken');
    }

    const updatedUser = userStore.updateProfile(userId, {
      name: name || user.name,
      email: email || user.email
    });

    req.session.user.name = updatedUser.name;
    req.session.user.email = updatedUser.email;
    console.log(`[AUTH] Profile updated: ${userId}`);
    return res.redirect('/control/settings?updated=profile');
  });

  app.post('/account/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword, confirmNewPassword } = req.body;
    const userId = req.session.user.id;
    const user = userStore.getUserById(userId);

    if (!user) {
      return res.redirect('/control/settings?error=user_not_found');
    }

    if (!verifyPassword(user, currentPassword)) {
      return res.redirect('/control/settings?error=wrong_password');
    }

    if (newPassword.length < 6) {
      return res.redirect('/control/settings?error=password_short');
    }

    if (newPassword !== confirmNewPassword) {
      return res.redirect('/control/settings?error=password_mismatch');
    }

    userStore.updatePassword(userId, hashPassword(newPassword), PASSWORD_ALGO);
    console.log(`[AUTH] Password changed: ${userId}`);
    res.redirect('/control/settings?updated=password');
  });

  app.post('/account/delete', requireAuth, (req, res) => {
    const userId = req.session.user.id;

    if (userId === 'guest' || userId === 'admin') {
      return res.redirect('/control/settings?error=cannot_delete');
    }

    userStore.deleteUser(userId);
    console.log(`[AUTH] Account deleted: ${userId}`);

    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  // ========================================
  // Flight Blender proxy (RID/DSS)
  // ========================================
  function parseBlenderPayload(payload) {
    if (typeof payload !== "string") {
      return payload;
    }
    try {
      return JSON.parse(payload);
    } catch (e) {
      return payload;
    }
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  async function getOwnedDroneIds(userId) {
    if (!userId) return new Set();
    try {
      const response = await axios.get(`${ATC_URL}/v1/drones`, {
        params: { owner_id: userId },
        timeout: 8000,
        validateStatus: () => true
      });
      if (!response || response.status >= 400) {
        return new Set();
      }
      return new Set((response.data || []).map(drone => drone.drone_id));
    } catch (error) {
      console.error("[ATC Proxy] Owned drone lookup failed:", error.message);
      return new Set();
    }
  }

  function declarationVisibleForUser(declaration, userEmail, ownedDroneIds) {
    if (!declaration) return false;
    const submittedBy = normalizeEmail(declaration.submitted_by);
    if (userEmail && submittedBy === userEmail) return true;
    const aircraftId = declaration.aircraft_id;
    return aircraftId && ownedDroneIds.has(aircraftId);
  }

  app.put("/api/rid/subscription", requireAuth, async (req, res) => {
    const view = req.query.view;
    if (!view) {
      return res.status(400).json({ message: "Missing view bbox" });
    }

    try {
      const token = ensureBlenderToken(["flightblender.read", "flightblender.write"], res);
      if (!token) return;
      const response = await axios.put(
        `${BLENDER_URL}/rid/create_dss_subscription`,
        null,
        {
          params: { view },
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[RID Proxy] Subscription error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.get("/api/rid/data/:subscriptionId", requireAuth, async (req, res) => {
    try {
      const token = ensureBlenderToken(["flightblender.read"], res);
      if (!token) return;
      const response = await axios.get(
        `${BLENDER_URL}/rid/get_rid_data/${req.params.subscriptionId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[RID Proxy] Data error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.post("/api/rid/demo", requireRole("authority"), async (req, res) => {
    if (!DEMO_MODE) {
      return res.status(404).json({ message: "not_found" });
    }
    try {
      const { testId, injectionId, payload } = buildDemoRidPayload(req.body?.center, req.body?.subscription_id);
      const token = ensureBlenderToken(["rid.inject_test_data"], res);
      if (!token) return;
      const response = await axios.put(
        `${BLENDER_URL}/rid/tests/${testId}`,
        payload,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json({
        test_id: testId,
        injection_id: injectionId,
        response: parseBlenderPayload(response.data)
      });
    } catch (error) {
      console.error("[RID Proxy] Demo injection error:", error.message);
      res.status(502).json({ message: "Failed to inject demo RID traffic" });
    }
  });

  // ========================================
  // ATC-Drone proxy (same-origin for frontend)
  // ========================================
  const ATC_PROXY_ALLOWLIST = [
    { methods: ["GET"], pattern: /^\/v1\/drones$/ },
    { methods: ["GET"], pattern: /^\/v1\/drones\/[^/]+$/ },
    { methods: ["POST"], pattern: /^\/v1\/drones\/register$/ },
    { methods: ["GET"], pattern: /^\/v1\/traffic$/ },
    { methods: ["GET"], pattern: /^\/v1\/conflicts$/ },
    { methods: ["GET"], pattern: /^\/v1\/conformance$/ },
    { methods: ["GET"], pattern: /^\/v1\/daa$/ },
    { methods: ["GET"], pattern: /^\/v1\/compliance\/limits$/ },
    { methods: ["POST"], pattern: /^\/v1\/compliance\/evaluate$/ },
    { methods: ["POST"], pattern: /^\/v1\/routes\/plan$/ },
    { methods: ["POST"], pattern: /^\/v1\/rid\/view$/ },
    { methods: ["GET", "POST"], pattern: /^\/v1\/commands$/ },
    { methods: ["GET"], pattern: /^\/v1\/geofences\/check$/ },
    { methods: ["POST"], pattern: /^\/v1\/geofences\/check-route$/ },
    { methods: ["GET", "POST"], pattern: /^\/v1\/geofences$/ },
    { methods: ["GET", "PUT", "DELETE"], pattern: /^\/v1\/geofences\/[^/]+$/ },
    { methods: ["POST"], pattern: /^\/v1\/flights\/plan$/ },
    { methods: ["GET", "POST"], pattern: /^\/v1\/flights$/ },
    { methods: ["POST"], pattern: /^\/v1\/operational_intents\/reserve$/ },
    { methods: ["POST"], pattern: /^\/v1\/operational_intents\/[^/]+\/confirm$/ },
    { methods: ["POST"], pattern: /^\/v1\/operational_intents\/[^/]+\/cancel$/ },
    { methods: ["PUT"], pattern: /^\/v1\/operational_intents\/[^/]+$/ }
  ];

  function isAllowedAtcProxy(method, requestPath) {
    return ATC_PROXY_ALLOWLIST.some(rule => (
      rule.methods.includes(method) && rule.pattern.test(requestPath)
    ));
  }

  function resolveAtcProxyTimeoutMs(method, requestPath) {
    const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "";
    const path = typeof requestPath === "string" ? requestPath : "";
    if (normalizedMethod === "POST") {
      if (path === "/v1/routes/plan" || path === "/v1/compliance/evaluate") {
        return 180_000;
      }
      if (path === "/v1/geofences/check-route" || path === "/v1/flights/plan") {
        return 60_000;
      }
      if (path === "/v1/operational_intents/reserve") {
        return 60_000;
      }
    }
    return 10_000;
  }

  function requiresAuthorityForAtc(method, requestPath) {
    if (method === "GET") return false;

    if (requestPath.startsWith("/v1/geofences/check")) return false;
    if (requestPath.startsWith("/v1/geofences/check-route")) return false;
    if (requestPath.startsWith("/v1/geofences") && ["POST", "PUT", "DELETE"].includes(method)) {
      return true;
    }
    if (requestPath.startsWith("/v1/admin")) return true;
    return false;
  }

  function requiresAdminTokenForAtc(method, requestPath) {
    if (requestPath === "/v1/commands" && ["GET", "POST"].includes(method)) {
      return true;
    }
    if (requestPath === "/v1/flights/plan" && method === "POST") {
      return true;
    }
    if (requestPath === "/v1/flights" && method === "POST") {
      return true;
    }
    if (requestPath.startsWith("/v1/operational_intents") && ["POST", "PUT"].includes(method)) {
      return true;
    }
    return false;
  }

  function isAuthority(req) {
    return req.session.user?.role === "authority";
  }

  async function canAccessDrone(req, droneId) {
    if (!droneId) return false;
    if (isAuthority(req)) return true;

    try {
      const response = await axios.get(`${ATC_URL}/v1/drones`, {
        timeout: 8000,
        validateStatus: () => true
      });
      if (!response || response.status >= 400) {
        console.error("[ATC Proxy] Drone lookup failed:", response?.status);
        return false;
      }

      const drones = Array.isArray(response.data) ? response.data : [];
      const drone = drones.find(entry => entry.drone_id === droneId);
      if (!drone) {
        return true;
      }
      if (!drone.owner_id) {
        return true;
      }
      return drone.owner_id === req.session.user?.id;
    } catch (error) {
      console.error("[ATC Proxy] Drone lookup error:", error.message);
      return false;
    }
  }

  async function canAccessFlight(req, flightId) {
    if (!flightId) return false;
    if (isAuthority(req)) return true;

    try {
      const ownerId = req.session.user?.id;
      if (!ownerId) return false;
      const response = await axios.get(`${ATC_URL}/v1/flights`, {
        params: { owner_id: ownerId },
        timeout: 8000,
        validateStatus: () => true
      });
      if (!response || response.status >= 400) {
        console.error("[ATC Proxy] Flight lookup failed:", response?.status);
        return false;
      }

      const plans = Array.isArray(response.data) ? response.data : [];
      return plans.some(entry => entry.flight_id === flightId);
    } catch (error) {
      console.error("[ATC Proxy] Flight lookup error:", error.message);
      return false;
    }
  }

  function applyOwnerId(req, payload) {
    if (isAuthority(req)) return payload;
    if (!payload || typeof payload !== "object") return payload;
    return { ...payload, owner_id: req.session.user?.id || null };
  }

  app.all(`${ATC_PROXY_BASE}/*`, requireAuth, async (req, res) => {
    const targetPath = req.originalUrl.replace(ATC_PROXY_BASE, "");
    const requestPath = req.path.startsWith(ATC_PROXY_BASE)
      ? req.path.slice(ATC_PROXY_BASE.length)
      : req.path;
    const url = `${ATC_URL}${targetPath}`;
    const method = req.method.toUpperCase();
    if (!isAllowedAtcProxy(method, requestPath)) {
      return res.status(404).json({ message: "not_found" });
    }
    if (requiresAuthorityForAtc(method, requestPath) && req.session.user?.role !== "authority") {
      return res.status(403).json({ message: "insufficient_role" });
    }
    if (!isAuthority(req)) {
      if (requestPath.startsWith("/v1/commands")) {
        if (method === "GET" && requestPath === "/v1/commands") {
          return res.status(403).json({ message: "insufficient_role" });
        }
        if (requestPath.startsWith("/v1/commands/ack")) {
          return res.status(403).json({ message: "insufficient_role" });
        }
        const droneId = method === "GET" ? req.query.drone_id : req.body?.drone_id;
        if (!droneId) {
          return res.status(400).json({ message: "missing_drone_id" });
        }
        const allowed = await canAccessDrone(req, droneId);
        if (!allowed) {
          return res.status(403).json({ message: "forbidden_drone" });
        }
      }

      if (requestPath.startsWith("/v1/flights") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const droneId = req.body?.drone_id;
        if (droneId) {
          const allowed = await canAccessDrone(req, droneId);
          if (!allowed) {
            return res.status(403).json({ message: "forbidden_drone" });
          }
        }
        if (req.body?.owner_id && req.body.owner_id !== req.session.user?.id) {
          return res.status(403).json({ message: "forbidden_owner" });
        }
        req.body = applyOwnerId(req, req.body);
      }

      if (requestPath.startsWith("/v1/operational_intents")) {
        if (requestPath === "/v1/operational_intents/reserve" && method === "POST") {
          const droneId = req.body?.drone_id;
          if (droneId) {
            const allowed = await canAccessDrone(req, droneId);
            if (!allowed) {
              return res.status(403).json({ message: "forbidden_drone" });
            }
          }
          if (req.body?.owner_id && req.body.owner_id !== req.session.user?.id) {
            return res.status(403).json({ message: "forbidden_owner" });
          }
          req.body = applyOwnerId(req, req.body);
        } else if (method === "PUT") {
          const droneId = req.body?.drone_id;
          if (droneId) {
            const allowed = await canAccessDrone(req, droneId);
            if (!allowed) {
              return res.status(403).json({ message: "forbidden_drone" });
            }
          }
          if (req.body?.owner_id && req.body.owner_id !== req.session.user?.id) {
            return res.status(403).json({ message: "forbidden_owner" });
          }
          req.body = applyOwnerId(req, req.body);
        } else if (method === "POST") {
          const flightId = requestPath.split("/").filter(Boolean)[2] || null;
          const allowed = await canAccessFlight(req, flightId);
          if (!allowed) {
            return res.status(403).json({ message: "forbidden_flight" });
          }
        }
      }
    }

    const data = ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? req.body : undefined;

    try {
      const headers = {
        "Content-Type": "application/json"
      };
      if (requestPath === "/v1/drones/register" && ATC_REGISTRATION_TOKEN) {
        headers["X-Registration-Token"] = ATC_REGISTRATION_TOKEN;
      }
      if (ATC_ADMIN_TOKEN && requiresAdminTokenForAtc(method, requestPath)) {
        headers.Authorization = `Bearer ${ATC_ADMIN_TOKEN}`;
      }

      const timeout = resolveAtcProxyTimeoutMs(method, requestPath);
      const response = await axios({
        method,
        url,
        data,
        timeout,
        validateStatus: () => true,
        headers
      });

      const upstreamContentType = response.headers?.["content-type"];
      if (upstreamContentType) {
        res.set("Content-Type", upstreamContentType);
      }

      if (response.data !== null && typeof response.data === "object" && !Buffer.isBuffer(response.data)) {
        return res.status(response.status).json(response.data);
      }
      return res.status(response.status).send(response.data);
    } catch (error) {
      const errMessage = error?.message || "unknown";
      console.error("[ATC Proxy] Request failed:", errMessage);
      const isTimeout =
        error?.code === "ECONNABORTED" ||
        errMessage.toLowerCase().includes("timeout");
      if (isTimeout) {
        return res.status(504).json({ message: "ATC request timed out" });
      }
      return res.status(502).json({ message: "Failed to reach ATC server" });
    }
  });

  // ========================================
  // Flight Declaration proxy (Mission Planning)
  // ========================================

  app.get("/api/blender/flight-declarations", requireAuth, async (req, res) => {
    try {
      const token = ensureBlenderToken(["flightblender.read"], res);
      if (!token) return;
      const response = await axios.get(
        `${BLENDER_URL}/flight_declaration_ops/flight_declaration`,
        {
          params: req.query,
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      let payload = parseBlenderPayload(response.data);
      if (!isAuthority(req)) {
        const userEmail = normalizeEmail(req.session.user?.email);
        const ownedDroneIds = await getOwnedDroneIds(req.session.user?.id);
        const records = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.results)
            ? payload.results
            : [];
        const filtered = records.filter(decl => declarationVisibleForUser(decl, userEmail, ownedDroneIds));
        if (Array.isArray(payload)) {
          payload = filtered;
        } else if (payload && Array.isArray(payload.results)) {
          payload = { ...payload, results: filtered };
        } else {
          payload = filtered;
        }
      }
      res.status(response.status).json(payload);
    } catch (error) {
      console.error("[Blender Proxy] Flight declarations error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.get("/api/blender/flight-declarations/:id", requireAuth, async (req, res) => {
    try {
      const token = ensureBlenderToken(["flightblender.read"], res);
      if (!token) return;
      const response = await axios.get(
        `${BLENDER_URL}/flight_declaration_ops/flight_declaration/${req.params.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      let payload = parseBlenderPayload(response.data);
      if (!isAuthority(req) && response.status < 400) {
        const userEmail = normalizeEmail(req.session.user?.email);
        const ownedDroneIds = await getOwnedDroneIds(req.session.user?.id);
        if (!declarationVisibleForUser(payload, userEmail, ownedDroneIds)) {
          return res.status(403).json({ message: "forbidden_declaration" });
        }
      }
      res.status(response.status).json(payload);
    } catch (error) {
      console.error("[Blender Proxy] Flight declaration detail error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.post("/api/blender/flight-declarations", requireAuth, async (req, res) => {
    if (!isAuthority(req)) {
      if (req.body?.aircraft_id) {
        const allowed = await canAccessDrone(req, req.body.aircraft_id);
        if (!allowed) {
          return res.status(403).json({ message: "forbidden_drone" });
        }
      }
      if (req.body && typeof req.body === "object") {
        req.body.submitted_by = req.session.user?.email || req.body.submitted_by;
      }
    }
    try {
      const token = ensureBlenderToken(["flightblender.write"], res);
      if (!token) return;
      const response = await axios.post(
        `${BLENDER_URL}/flight_declaration_ops/set_flight_declaration`,
        req.body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[Blender Proxy] Flight declaration submit error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  app.delete("/api/blender/flight-declarations/:id", requireAuth, async (req, res) => {
    const declarationId = req.params.id;
    if (!declarationId) {
      return res.status(400).json({ message: "declaration_id_required" });
    }

    try {
      if (!isAuthority(req)) {
        const token = ensureBlenderToken(["flightblender.read"], res);
        if (!token) return;
        const detail = await axios.get(
          `${BLENDER_URL}/flight_declaration_ops/flight_declaration/${declarationId}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000,
            validateStatus: () => true
          }
        );
        if (detail.status >= 400) {
          return res.status(detail.status).json(parseBlenderPayload(detail.data));
        }
        const payload = parseBlenderPayload(detail.data);
        const userEmail = normalizeEmail(req.session.user?.email);
        const ownedDroneIds = await getOwnedDroneIds(req.session.user?.id);
        if (!declarationVisibleForUser(payload, userEmail, ownedDroneIds)) {
          return res.status(403).json({ message: "forbidden_declaration" });
        }
      }

      const token = ensureBlenderToken(["flightblender.write"], res);
      if (!token) return;
      const response = await axios.delete(
        `${BLENDER_URL}/flight_declaration_ops/flight_declaration/${declarationId}/delete`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
          validateStatus: () => true
        }
      );
      if (response.status === 204) {
        return res.status(204).send();
      }
      res.status(response.status).json(parseBlenderPayload(response.data));
    } catch (error) {
      console.error("[Blender Proxy] Flight declaration delete error:", error.message);
      res.status(502).json({ message: "Failed to reach Flight Blender" });
    }
  });

  // ========================================
  // Protected Routes
  // ========================================

  // Mission Control routes (require authentication)
  app.use("/control", requireAuth, controlRouter);

  // Redirect root to control
  app.get('/', (req, res) => {
    if (req.session.user) {
      res.redirect('/control');
    } else {
      res.redirect('/login');
    }
  });

  // SDK Documentation (public)
  app.get('/docs', (req, res) => {
    res.render('docs', { user: req.session.user || null });
  });

  // Constants
  const port = process.env.PORT || 5050;
  const atcWsProxyPath = `${ATC_PROXY_BASE}/v1/ws`;
  let server = app.listen(port, "0.0.0.0", () => {
    console.log(`[SERVER] Listening on 0.0.0.0:${port}`);
    console.log(`[CONFIG] ATC_URL: ${ATC_URL}`);
  });

  // ========================================
  // WebSocket Proxy (same-origin)
  // ========================================
  function parseUpgradeUrl(req) {
    try {
      return new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      return null;
    }
  }

  function rejectUpgrade(socket, status = 401, message = "Unauthorized") {
    try {
      socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
    } finally {
      socket.destroy();
    }
  }

  function buildAtcWsPath(user, clientUrl) {
    const params = new URLSearchParams();
    const isAuthority = user?.role === "authority";
    const requestedOwnerId = clientUrl.searchParams.get("owner_id");
    const ownerId = isAuthority ? requestedOwnerId : (user?.id || null);
    const droneId = clientUrl.searchParams.get("drone_id");

    if (ownerId) params.set("owner_id", ownerId);
    if (droneId) params.set("drone_id", droneId);

    const query = params.toString();
    return query ? `/v1/ws?${query}` : "/v1/ws";
  }

  server.on("upgrade", (req, socket, head) => {
    const url = parseUpgradeUrl(req);
    if (!url) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== atcWsProxyPath) {
      return;
    }

    // Reuse express-session to authenticate the websocket upgrade.
    const res = {
      getHeader: () => undefined,
      setHeader: () => {},
      writeHead: () => {},
      end: () => {}
    };

    sessionMiddleware(req, res, () => {
      const user = req.session?.user;
      if (!user) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }

      let atcUrl;
      try {
        atcUrl = new URL(ATC_URL);
      } catch (err) {
        console.error("[ATC WS Proxy] Invalid ATC_URL:", err?.message || err);
        rejectUpgrade(socket, 502, "Bad Gateway");
        return;
      }

      const isTls = atcUrl.protocol === "https:";
      const port = atcUrl.port
        ? Number(atcUrl.port)
        : (isTls ? 443 : 80);
      const host = atcUrl.hostname;
      const targetPath = buildAtcWsPath(user, url);
      const upstreamHeaders = [];
      const forwardHeader = (name, value) => {
        if (!value) return;
        upstreamHeaders.push(`${name}: ${value}`);
      };

      const secKey = req.headers["sec-websocket-key"];
      const secVersion = req.headers["sec-websocket-version"];
      if (!secKey || !secVersion) {
        rejectUpgrade(socket, 400, "Bad Request");
        return;
      }

      const secExtensions = req.headers["sec-websocket-extensions"];
      const secProtocol = req.headers["sec-websocket-protocol"];
      const origin = req.headers.origin;

      forwardHeader("Host", atcUrl.host || `${host}:${port}`);
      forwardHeader("Connection", "Upgrade");
      forwardHeader("Upgrade", "websocket");
      forwardHeader("Sec-WebSocket-Key", secKey);
      forwardHeader("Sec-WebSocket-Version", secVersion);
      forwardHeader("Sec-WebSocket-Extensions", secExtensions);
      forwardHeader("Sec-WebSocket-Protocol", secProtocol);
      forwardHeader("Origin", origin);
      if (ATC_WS_TOKEN) {
        forwardHeader("Authorization", `Bearer ${ATC_WS_TOKEN}`);
      }

      const requestLines = [
        `GET ${targetPath} HTTP/1.1`,
        ...upstreamHeaders,
        "\r\n"
      ];
      const requestPayload = requestLines.join("\r\n");

      const connectOptions = { host, port };
      const upstream = isTls
        ? tls.connect({
          ...connectOptions,
          servername: host,
          rejectUnauthorized: process.env.NODE_ENV === "production"
        })
        : net.connect(connectOptions);

      const teardown = () => {
        socket.destroy();
        upstream.destroy();
      };

      upstream.on("error", (err) => {
        console.error("[ATC WS Proxy] Upstream error:", err?.message || err);
        teardown();
      });
      socket.on("error", () => {
        teardown();
      });

      upstream.on("connect", () => {
        socket.setKeepAlive(true, 30_000);
        upstream.setKeepAlive(true, 30_000);

        upstream.write(requestPayload);
        if (head && head.length) {
          upstream.write(head);
        }

        const handshakeTimer = setTimeout(() => {
          console.error("[ATC WS Proxy] Upstream handshake timeout");
          teardown();
        }, 10_000);
        upstream.once("data", () => {
          clearTimeout(handshakeTimer);
        });

        upstream.pipe(socket);
        socket.pipe(upstream);
      });
    });
  });


  server.on("error", function (e) {
    console.log(e);
    process.exit(1);
  });

  server.on("close", function (e) {
    console.log("Cesium development server stopped.");
  });

  let isFirstSig = true;
  process.on("SIGINT", function () {
    if (isFirstSig) {
      console.log("Cesium development server shutting down.");
      server.close(function () {
        process.exit(0);
      });
      isFirstSig = false;
    } else {
      console.log("Cesium development server force kill.");
      process.exit(1);
    }
  });
})();
