
const redis_client = require('../routes/redis-client');
const axios = require('axios');
require("dotenv").config();
const qs = require('qs');
let passport_helper = require('../routes/passport_helper');


async function createBlenderADSBFeedProcess(job) {
    try {
        const passport_token = await passport_helper.getPassportToken();
        const cred = `Bearer ${passport_token}`;
        const base_url = process.env.BLENDER_BASE_URL || 'http://local.test:8000';
        const { viewport, job_id, job_type } = job.data;
        const viewport_str = viewport.join(',');

        const axios_instance = axios.create({
            headers: {
                'Content-Type': 'application/json',
                'Authorization': cred
            }
        });
        const adsb_feed_url = `${base_url}/flight_stream/start_opensky_feed?view=${viewport_str}`;
        const blender_response = await axios_instance.get(adsb_feed_url);
        console.log("Openskies Stream started...");
    } catch (error) {
        console.error("Error in starting Openskies Stream:", error.response?.data || error.message);
    }
}

module.exports = {
    createBlenderADSBFeedProcess,
};
