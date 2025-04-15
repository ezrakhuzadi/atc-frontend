const express = require('express');
const router = express.Router();


const { requiresAuth } = require('express-openid-connect');
const asyncMiddleware = require('../util/asyncMiddleware');
const {
  DateTime
} = require("luxon");

const redis_client = require('./redis-client');
let passport_helper = require('./passport_helper');
let geojsonhint = require("@mapbox/geojsonhint");
const {
  check,
  validationResult
} = require('express-validator');
const axios = require('axios');


let flight_operation_validate = [
  check('operator_name').isLength({
    min: 5,
    max: 50
  }).withMessage("Operator name is required and must be more than 5 and less than 50 characters")
    .trim(),
  check('geojson_upload_control').custom(submitted_geo_json => {

    let options = {};
    let errors = geojsonhint.hint(submitted_geo_json, options);

    if (errors.length > 0) {
      throw new Error('Invalid GeoJSON supplied.');
    } else {
      return true;
    }
  }),
  check('altitude_agl').isInt({ min: 0, max: 4000 }).withMessage("Altitude must be provided as an integer between 0 to 4000 mts."),
  check('op_date').isISO8601().withMessage("A valid date must be provided for the operation"),
  check("op_start", "op_end")
    .isInt()
    .custom((op_start, { req }) => {
      if (parseInt(op_start) > parseInt(req.body.op_end)) {
        // trow error if passwords do not match
        throw new Error("Operation End Time cannot be before Start. ");
      } else {
        return true;
      }
    }),
];

router.post('/launchpad/submit-declaration', flight_operation_validate, requiresAuth(), async function (req, res, next) {

  let userProfile;
  try {
    userProfile = await req.oidc.fetchUserInfo();
  } catch (error) {
    return res.redirect('/');
  }

  const errors = validationResult(req);
  const operators = process.env.OPERATORS || "";


  if (!errors.isEmpty()) {
    return res.render('launchpad', {
      data: req.body,
      errors: errors.mapped(),
      operators: operators,
      user: req.user,
      userProfile: userProfile
    });
  }

  const {
    op_date,
    op_start,
    op_end,
    operation_type,
    altitude_agl,
    submitted_by,
    operator_name,
    geojson_upload_control
  } = req.body;

  const start_date = DateTime.fromISO(op_date);
  const start_time = start_date.set({ hour: Math.floor(op_start / 60), minute: op_start % 60 });
  const end_time = start_date.set({ hour: Math.floor(op_end / 60), minute: op_end % 60 });

  const geojson_upload = JSON.parse(geojson_upload_control);
  const geo_json_with_altitude = {
    type: 'FeatureCollection',
    features: geojson_upload.features.map(feature => ({
      ...feature,
      properties: {
        min_altitude: { meters: altitude_agl, datum: "agl" },
        max_altitude: { meters: altitude_agl, datum: "agl" }
      }
    }))
  };

  const flight_declaration_json = {
    start_datetime: start_time.toISO(),
    end_datetime: end_time.toISO(),
    aircraft_id: "83a5a039-8fa0-4780-bfae-ee7ba458af0c",
    type_of_operation: operation_type,
    submitted_by: submitted_by,
    is_approved: process.env.DEFAULT_APPROVED || 0,
    originating_party: operator_name,
    flight_declaration_geo_json: geo_json_with_altitude
  };

  try {
    const passport_token = await passport_helper.getPassportToken();
    const response = await axios.post(`${process.env.BLENDER_BASE_URL || 'http://local.test:8000'}/flight_declaration_ops/set_flight_declaration`, flight_declaration_json, {
      headers: {
        "Authorization": `Bearer ${passport_token}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 200) {
      return res.render('launchpad-operation-submission-status', {
        title: "Thank you for your submission!",
        errors: [],
        data: response.data,
        user: req.user,
        userProfile: userProfile
      });
    } else {
      return res.render('error-in-submission', {
        title: "Error in submission",
        errors: response.data,

        user: req.user,
        userProfile: userProfile,
        data: {}
      });
    }
  } catch (error) {
    const error_message = error.response ? error.response.data.message : error.message;
    return res.render('launchpad-operation-submission-status', {
      title: "Error in your submission!",
      errors: [{ message: error.message, data: error_message }],
      data: {},

      user: req.user,
      userProfile: userProfile
    });
  }
});


router.get('/launchpad', requiresAuth(), async (req, response, next) => {

  let userProfile;
  try {
    userProfile = await req.oidc.fetchUserInfo();
  } catch (error) {
    return response.redirect('/');
  }
  const operators = process.env.OPERATORS || "";
  response.render('launchpad', { 'operators': operators, 'user': req.user, 'errors': [], 'userProfile': userProfile });
});

router.get('/launchpad/operation-status/:uuid', asyncMiddleware(async (req, res, next) => {

  let userProfile;
  try {
    userProfile = await req.oidc.fetchUserInfo();
  } catch (error) {
    return response.redirect('/');
  }
  const operationUUID = req.params.uuid;

  
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationUUID);

  if (!isUUID) {
    return res.status(400).send("No operation specified.");
  }

  try {
    const passportToken = await passport_helper.getPassportToken();
    const baseURL = process.env.BLENDER_BASE_URL || 'http://local.test:8000';
    const url = `${baseURL}/flight_declaration_ops/flight_declaration/${operationUUID}`;

    const blenderResponse = await axios.get(url, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${passportToken}`
      }
    });

    if (blenderResponse.status === 200) {
      return res.render('launchpad-status', {
        title: "Operation Status",
        errors: {},
        data: blenderResponse.data,
        'userProfile': userProfile
      });
    } else {
      return res.render('error-in-submission', {
        title: "Error in submission",
        errors: blenderResponse.data,
        'userProfile': userProfile,
        data: {}
      });
    }
  } catch (error) {
    return res.render('error-in-submission', {
      title: "Error in submission",
      errors: [{ message: error.message }],
      data: {},
      'userProfile': userProfile
    });
  }

}));


module.exports = router;
