// processor.js

const redis_client = require('../routes/redis-client');
const tile38_host = process.env.TILE38_SERVER || '0.0.0.0';
const tile38_port = process.env.TILE38_PORT || 9851;

const { v4: uuidv4 } = require('uuid');
var Tile38 = require('tile38');
const axios = require('axios');
require("dotenv").config();
const qs = require('qs');
var tile38_client = new Tile38({ host: tile38_host, port: tile38_port });
let passport_helper = require('../routes/passport_helper');

const delay = ms => new Promise(res => setTimeout(res, ms));

function setObservationsLocally(observations) {
    for (const current_observation of observations) {
        const { lon_dd, lat_dd, icao_address, altitude_mm, source_type, traffic_source, metadata } = current_observation;

        metadata.source_type = source_type;
        metadata.traffic_source = traffic_source;

        try {
            tile38_client.set('observation', icao_address, [lat_dd, lon_dd, altitude_mm], metadata, { expire: 300 });
        } catch (err) {
            console.log("Error " + err);
        }

        const metadata_key = `${icao_address}-metadata`;
        (async () => {
            try {
                await redis_client.set(metadata_key, JSON.stringify(metadata));
                await redis_client.expire(metadata_key, 300);
            } catch (err) {
                console.log("Error setting metadata: " + err);
            }
        })();
    }
}

const pollBlenderProcess = async (job) => {
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
    let session_id = uuidv4();
    const flights_url = `${base_url}/flight_stream/get_air_traffic/${session_id}?view=${viewport_str}`;
    console.debug(`Flights url: ${flights_url}`);

    const fullproc = 15;
    for (let h = 0; h < fullproc; h++) {
        try {
            const blender_response = await axios_instance.get(flights_url);
            const observations = blender_response.data['observations'];
            const obs_len = observations.length;
            console.log(`Processing ${obs_len} observations`);
            if (obs_len > 0) {
                setObservationsLocally(observations);
            }
        } catch (blender_error) {
            console.log("Error in retrieving data from Blender");
            console.log(blender_error);
        }
        await delay(3000);
        console.log('Waiting 3 seconds ..');
    }
    console.log('Computation Complete..');
};

module.exports = {
    pollBlenderProcess,
};
