
const redis_client = require('../routes/redis-client');
const axios = require('axios');
require("dotenv").config();
const qs = require('qs');
let passport_helper = require('../routes/passport_helper');


const createBlenderDSSSubscriptionProcess = async (job) => {
    try {
        const passport_token = await passport_helper.getPassportToken();
        const cred = `Bearer ${passport_token}`;
        const base_url = process.env.BLENDER_BASE_URL || 'http://local.test:8000';
        const { viewport, job_id, job_type } = job.data;
        const axios_instance = axios.create({
            headers: {
                'Content-Type': 'application/json',
                'Authorization': cred
            }
        });
        const viewport_str = viewport.join(',');
        const dss_subscription_create_url = `${base_url}/rid/create_dss_subscription?view=${viewport_str}`;
        console.log("Creating DSS Subscription...");
        const blender_response = await axios_instance.put(dss_subscription_create_url);
        console.log("DSS Subscription started...");
    } catch (error) {
        console.error("Error in creating a DSS subscription:", error.response?.data || error.message);
    }

}

module.exports = {
    createBlenderDSSSubscriptionProcess,
};



