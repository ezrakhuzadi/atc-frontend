// processor.js

const redis_client = require('../routes/redis-client');
const tile38_host = process.env.TILE38_SERVER || '0.0.0.0';
const tile38_port = process.env.TILE38_PORT || 9851;


var Tile38 = require('tile38');
const axios = require('axios');
require("dotenv").config();
const qs = require('qs');
const tile38_client = new Tile38({ host: tile38_host, port: tile38_port });
let passport_helper = require('../routes/passport_helper');

const socket = require('../util/io');



function setGeoFenceLocally(geo_fence_detail) {

    const geo_fence_list = geo_fence_detail;

    for (const geo_fence of geo_fence_list) {

        const geo_fence_id = geo_fence['id']


        let upper_limit = geo_fence['upper_limit'];
        let lower_limit = geo_fence['lower_limit'];
        // Create a new geo fence
        console.info("Setting Geozone..");
        tile38_client.set('geo_fence_in_aoi', geo_fence_id, geo_fence.raw_geo_fence, {
            'upper_limit': upper_limit,
            'lower_limit': lower_limit
        }, {
            expire: 60
        });

    }
}
function sleep (time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}
const getGeoFenceConsumerProcess = async (job) => {

    await new Promise(r => setTimeout(r, 2000));
    try {
        const passport_token = await passport_helper.getPassportToken();
        const cred = `Bearer ${passport_token}`;
        const base_url = process.env.BLENDER_BASE_URL || 'http://local.test:8000';
        const userEmail = job.data.userEmail;
        const viewport = job.data.viewport.join(',');
        const geo_fence_url = `${base_url}/geo_fence_ops/geo_fence?view=${viewport}`;

        const axios_instance = axios.create({
            headers: {
                'Content-Type': 'application/json',
                'Authorization': cred
            }
        });

        const blender_response = await axios_instance.get(geo_fence_url);
        const geo_fences = blender_response.data;

        if (geo_fences.results) {
            setGeoFenceLocally(geo_fences.results);
        }

        console.log('Geozone query complete..');
        view_port = viewport.split(',');
        console.log(view_port);
        sleep(2000);
        const geo_fence_query = tile38_client.intersectsQuery('geo_fence').bounds(view_port[0], view_port[1], view_port[2], view_port[3]);

        const geo_fence_results = await geo_fence_query.execute();
        console.log("Found Geofence..")

        const io = socket.getInstance();
        const sendStdMsg = socket.sendStdMsg;
        try {
            sendStdMsg(userEmail, {
                'type': 'message',
                "alert_type": "geo_fence_in_aoi",
                "results": geo_fence_results
            });
        } catch (error) {
            console.error("Error in sending data to client", error);
        }

        geo_fence_results.objects.forEach(geo_fence_element => {
            const geo_fence_bbox = turf.bbox(geo_fence_element.object);
            const geo_live_fence_query = tile38_client.intersectsQuery('observation').detect('enter', 'exit').bounds(...geo_fence_bbox);
            const geo_fence_stream = geo_live_fence_query.executeFence((err, geo_fence_results) => {
                if (err) {
                    console.error("something went wrong! " + err);
                } else {
                    const status = `${geo_fence_results.id}: ${geo_fence_results.detect} geo fence area`;
                    io.sockets.in(userEmail).emit("message", {
                        'type': 'message',
                        "alert_type": "geo_fence_crossed",
                        "results": status
                    });
                }
            });

            geo_fence_stream.onClose(() => {
                console.log(`Close Geozone geofence with id: ${geo_fence_element.object.id}`);
            });

            setTimeout(() => {
                geo_fence_stream.close();
            }, 30000);
        });


    } catch (error) {
        console.error("Error in retrieving data from Blender", error);
    }
};

module.exports = {
    getGeoFenceConsumerProcess,
};
