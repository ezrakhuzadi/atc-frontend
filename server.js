(async function () {
    'use strict';
    /*jshint node:true*/

    const express = require('express');
    const { socketConnection } = require('./util/io');
    require("dotenv").config();

    const spotlightNoticeboardRouter = require("./routes/spotlight_noticeboard");
    const launchpadRouter = require('./routes/launchpad');
    const auth_strategy = process.env.AUTH_STRATEGY || 'flightpassport';
    const authHandlers = {
        'flightpassport': './auth_mechanisms/flight_passport/auth_handler',

    };

    let app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }))
    app.set('view engine', 'ejs');
    app.use(express.static(__dirname + '/views'));
    app.use('/assets', express.static('static'));

    const authHandlerPath = authHandlers[auth_strategy];
    if (authHandlerPath) {
        const authHandler = require(authHandlerPath);
        app.use(authHandler());
    } else {
        console.error(`Unknown authentication strategy: ${auth_strategy}`);
    }

    app.get('/auth', (req, res) =>
        res.oidc.login({
            returnTo: '/noticeboard',
        })
    );

    app.use("/", spotlightNoticeboardRouter);
    app.use('/', launchpadRouter);


    // Constants
    let server = app.listen(process.env.PORT || 5000);

    socketConnection(server);
    // app.set('socketio', io_module.getInstance());

    server.on('error', function (e) {
        console.log(e);
        process.exit(1);
    });

    server.on('close', function (e) {
        console.log('Cesium development server stopped.');
    });

    let isFirstSig = true;
    process.on('SIGINT', function () {
        if (isFirstSig) {
            console.log('Cesium development server shutting down.');
            server.close(function () {
                process.exit(0);
            });
            isFirstSig = false;
        } else {
            console.log('Cesium development server force kill.');
            process.exit(1);
        }
    });

})();