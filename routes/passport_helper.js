
const redis_client = require('./redis-client');
const axios = require('axios');

require("dotenv").config();
const qs = require('qs');

module.exports = {
  getPassportToken: async function getPassportToken() {
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
