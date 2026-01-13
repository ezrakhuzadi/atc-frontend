// Dev-mode auth bypass handler
// This replaces OAuth authentication with a mock user for local development

module.exports = function () {
    return (req, res, next) => {
        // Mock OIDC-like interface for dev mode
        req.oidc = {
            isAuthenticated: () => true,
            user: {
                sub: 'dev-user-001',
                email: 'dev@atc-drone.local',
                name: 'Dev User'
            },
            fetchUserInfo: async () => ({
                sub: 'dev-user-001',
                email: 'dev@atc-drone.local',
                name: 'Dev User',
                role: 'authority'  // Can be 'authority' or 'operator'
            })
        };
        next();
    };
};
