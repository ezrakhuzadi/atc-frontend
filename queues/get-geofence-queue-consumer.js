// processor.js

const redis_client = require("../routes/redis-client");
const tile38_host = process.env.TILE38_SERVER || "0.0.0.0";
const tile38_port = process.env.TILE38_PORT || 9851;

const turf = require("@turf/turf");

var Tile38 = require("tile38");
const axios = require("axios");
require("dotenv").config();
const qs = require("qs");
const tile38_client = new Tile38({ host: tile38_host, port: tile38_port });
let passport_helper = require("../routes/passport_helper");
const { sendStdMsg } = require("../util/io");

function setGeoFenceLocally(geo_fence_detail) {
  const geo_fence_list = geo_fence_detail;

  for (const geo_fence of geo_fence_list) {
    const geo_fence_id = geo_fence["id"];

    let upper_limit = geo_fence["upper_limit"];
    let lower_limit = geo_fence["lower_limit"];
    // Create a new geo fence
    console.info("Setting Geozone..");
    tile38_client.set(
      "geo_fence_in_aoi",
      geo_fence_id,
      geo_fence.raw_geo_fence,
      {
        upper_limit: upper_limit,
        lower_limit: lower_limit,
      },
      {
        expire: 60,
      }
    );
  }
}

const getGeoFenceConsumerProcess = async (job) => {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const passport_token = await passport_helper.getPassportToken();
    const cred = `Bearer ${passport_token}`;
    const base_url = process.env.BLENDER_BASE_URL || "http://local.test:8000";
    const userEmail = job.data.userEmail;
    const viewport = job.data.viewport.join(",");

    const geo_fence_url = `${base_url}/geo_fence_ops/geo_fence?view=${viewport}`;

    const axios_instance = axios.create({
      headers: {
        "Content-Type": "application/json",
        Authorization: cred,
      },
    });

    const blender_response = await axios_instance.get(geo_fence_url);
    const geo_fences = blender_response.data;

    if (geo_fences.results) {
      setGeoFenceLocally(geo_fences.results);
    }

    console.log("Geozone query complete..");
    let viewPort = viewport.split(",");

    const geo_fence_query = tile38_client
      .intersectsQuery("geo_fence_in_aoi")
      .bounds(viewPort[0], viewPort[1], viewPort[2], viewPort[3]);

    const geo_fence_results = await geo_fence_query.execute();
    console.log("Found Geofence..");

    sendStdMsg(userEmail, {
      type: "message",
      alert_type: "geo_fence_in_aoi",
      results: geo_fence_results,
    });
  } catch (error) {
    console.error("Error in retrieving data from Blender", error);
  }
};

module.exports = {
  getGeoFenceConsumerProcess,
};
