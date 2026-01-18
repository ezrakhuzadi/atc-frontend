/**
 * Mission Control Routes
 * Complete routes for Control Center application
 */

const express = require('express');
const { requireRole } = require('../util/auth');
const router = express.Router();

// ============================================
// Main Pages
// ============================================

// Dashboard (Control Center Home)
router.get('/', (req, res) => {
    res.render('dashboard', { user: req.session.user });
});

// Live Map
router.get('/map', (req, res) => {
    res.render('map', { user: req.session.user });
});

// Fleet Management
router.get('/fleet', (req, res) => {
    res.render('fleet', { user: req.session.user });
});

// ============================================
// Missions
// ============================================

// Missions list
router.get('/missions', (req, res) => {
    res.render('missions', { user: req.session.user });
});

// Plan new mission
router.get('/missions/plan', (req, res) => {
    res.render('mission-plan', { user: req.session.user });
});

// Flight planner (standalone client embedded)
router.get('/flight-planner', (req, res) => {
    res.render('flight-planner', { user: req.session.user });
});

// Mission detail
router.get('/missions/:id', (req, res) => {
    res.render('mission-detail', {
        user: req.session.user,
        missionId: req.params.id
    });
});

// ============================================
// Geofences
// ============================================

router.get('/geofences', (req, res) => {
    res.render('geofences', { user: req.session.user });
});

router.get('/geofences/create', requireRole('authority'), (req, res) => {
    res.render('geofence-create', { user: req.session.user });
});

// ============================================
// Conflicts
// ============================================

router.get('/conflicts', requireRole('authority'), (req, res) => {
    res.render('conflicts', { user: req.session.user });
});

// ============================================
// Remote ID (ASTM F3411)
// ============================================

router.get('/remote-id', (req, res) => {
    res.render('remote-id', { user: req.session.user });
});

// ============================================
// Analytics
// ============================================

router.get('/analytics', requireRole('authority'), (req, res) => {
    res.render('analytics', { user: req.session.user });
});

// ============================================
// Settings
// ============================================

router.get('/settings', (req, res) => {
    res.render('settings', { user: req.session.user });
});

// ============================================
// Drone Detail
// ============================================

router.get('/drone/:id', (req, res) => {
    res.render('drone-detail', {
        user: req.session.user,
        droneId: req.params.id
    });
});

module.exports = router;
