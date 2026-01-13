// Custom requiresAuth middleware for dev mode
// In dev mode, always allows access since user is mocked

const { requiresAuth: oidcRequiresAuth } = require('express-openid-connect');

function requiresAuth() {
    const authStrategy = process.env.AUTH_STRATEGY || 'flightpassport';

    if (authStrategy === 'dev_bypass') {
        // In dev mode, just pass through - user is already mocked
        return (req, res, next) => next();
    }

    // In production, use the real OIDC requiresAuth
    return oidcRequiresAuth();
}

module.exports = { requiresAuth };
