let io = null;
exports.socketConnection = (httpServer) => {
    io = require('socket.io')(httpServer);
    io.on('connection', function (socket) {
        console.log('New client connected with id = ', socket.id);
        socket.on('disconnect', function (reason) {
            console.log('A client disconnected with id = ', socket.id, " reason ==> ", reason);
        });
    });

    let active_users = new Set();
    io.on('connection', function (socket) {
        socket.on('room', function (room) {
            active_users.add(room);
            socket.join(room);
            sendWelcomeMsg(room);
        });
        socket.on('message', function (msg) {
            let room = msg.room;
            let data = msg.data;
            sendStdMsg(room, data);
        });
        socket.on("disconnect", () => {
            active_users.delete(socket.userId);
            io.emit("user disconnected", socket.userId);
        });
    });

    function sendWelcomeMsg(room) {
        io.sockets.in(room).emit('welcome', 'Joined ' + room);
    }

    function sendStdMsg(room, data) {
        io.sockets.in(room).emit('message', { 'type': 'message', 'data': data });
    }


};
exports.sendStdMsg = (room, data) => {
    console.log(`[Socket.IO] Sending message to room: ${room}`);
    console.log(`[Socket.IO] Message data: ${JSON.stringify(data).slice(0, 200)}...`);
    io.sockets.in(room).emit('message', data);
};
//return the io instance
exports.getInstance = function () {
    return io;
};