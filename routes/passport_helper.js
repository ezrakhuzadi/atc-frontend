
const redis_client = require('./redis-client');
const axios = require('axios');

require("dotenv").config();
const qs = require('qs');

// Simple JWT generator for dev mode (no crypto needed for dummy tokens)
function generateDevToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'dummy',
    sub: 'spotlight-dev',
    aud: process.env.PASSPORT_BLENDER_AUDIENCE || 'testflight.flightblender.com',
    scope: process.env.PASSPORT_BLENDER_SCOPE || 'flightblender.read flightblender.write',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000)
  })).toString('base64url');
  const signature = Buffer.from('dummy-signature').toString('base64url');
  return `${header}.${payload}.${signature}`;
}

module.exports = {
  getPassportToken: async function getPassportToken() {
    // In dev mode, return a dummy token instead of calling OAuth server
    const authStrategy = process.env.AUTH_STRATEGY || 'flightpassport';
    if (authStrategy === 'dev_bypass') {
      return generateDevToken();
    }

    const redisKey = 'blender_passport_token';
    const storedToken = await redis_client.get(redisKey);

    if (storedToken) {
      const rawToken = JSON.parse(storedToken);
      return rawToken['access_token'];
    }

    const postData = {
      client_id: process.env.PASSPORT_BLENDER_CLIENT_ID,
      client_secret: process.env.PASSPORT_BLENDER_CLIENT_SECRET,
      grant_type: "client_credentials",
      scope: process.env.PASSPORT_BLENDER_SCOPE,
      audience: process.env.PASSPORT_BLENDER_AUDIENCE
    };

    try {
      const res = await axios.request({
        url: process.env.PASSPORT_TOKEN_URL || '/oauth/token/',
        method: "post",
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        baseURL: process.env.PASSPORT_URL,
        data: qs.stringify(postData)
      });

      if (res.status === 200) {
        const accessToken = res.data;
        await redis_client.set(redisKey, JSON.stringify(accessToken));
        await redis_client.expire(redisKey, 3500);

        return accessToken['access_token'];
      } else {
        console.log(res);
        throw new Error("Error in Passport Query, response not 200");
      }
    } catch (error) {
      console.log(error);
      return { error: error.message };
    }
  }
};
