var async = require('async');
var express = require('express');
var app = express();
var http = require('http');
var exphbs = require('express-handlebars');
var path = require('path');
var bodyParser = require('body-parser');
var r = require('rethinkdb');
var ip = require('ip');
var firebase = require("firebase");

var devid = "ZXCVBNM";

var io,socket;

var routes = require('./routes');
var config = require(__dirname + '/config.js');

//For serving the index.html and all the other front-end assets.
app.use(express.static(__dirname + '/public'));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));



firebase.initializeApp({
  serviceAccount: "devices-067e8ea631b1.json",
  databaseURL: "https://devices-6b6f6.firebaseio.com/"
});
var fbase = firebase.database().ref();
var deviceid = fbase.child(devid+"/data");
var abc = {};
abc[devid+"/authKey"] = 'abcdef';
fbase.update(abc);
deviceid.push({
  some : "sensor data"
});


app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');

app.get('/', function(req,res){

  async.waterfall([
    function getSensorData(callback){
      var options = {
      host: '127.0.0.1',
      port: 80,
      path: '/sensors',
      method: 'GET'
      };
    http.request(options, function(res) {
      res.setEncoding('utf8');
      res.on('data', function (sensorData) {
        callback(sensorData);
      });
    }).end();
    }
  ], function(sensorData){
    sensorData = JSON.parse(sensorData);
    //console.log(sensorData);
    res.render('home', { data: sensorData });
  });
});


//testing
app.get('/test', function (req, res){
  res.json({message: 'hooray! welcome to our api!'});
});

//cloud setup
app.get('/setup', function (req, res){
  res.render('setup');
});

//The REST routes for "sensors".
app.route('/sensors')
  .get(listSensors)
  .post(createSensor);

//If we reach this middleware the route could not be handled and must be unknown.
app.use(handle404);

/*
 * Retrieve all sensor data.
 */
function listSensors(req, res, next) {
  r.table('sensors').orderBy({index: r.desc('createdAt')}).run(req.app._rdbConn, function(err, cursor) {
    if(err) {
      return next(err);
    }

    //Retrieve all the todos in an array.
    cursor.toArray(function(err, result) {
      if(err) {
        return next(err);
      }

      res.json(result);
    });
  });
}

/*
 * Insert a new sensor
 */
function createSensor(req, res, next) {

  var sensorData = req.body;
  var sensorName = sensorData.name;
  sensorData.createdAt = r.now();
//console.log(sensorData);
  r.db('Devices').table('sensors').filter(r.row('name').eq(sensorName)).run(req.app._rdbConn, function(err, cursor) {

    if(err) {
      return next(err);
    }
    cursor.toArray(function(err, result) { // Result of matched data.
      //console.log(result);
            if (err) return next(err);
            if(result.length>=1){ // Record already exists
              var resultID = result[0]['id']; // Gets ID.
              r.table('sensors').get(resultID).update(sensorData).run(req.app._rdbConn, function(err, result) {
                if(err) {
                  return next(err);
                }

                res.json({response: 'updated'});
              });

            } else {
              r.table('sensors').insert(sensorData).run(req.app._rdbConn, function(err, result) {
                if(err) {
                  return next(err);
                }

                res.json({response: 'added'});
              });
            }
        });
  });
}

/*
 * Page-not-found middleware.
 */
function handle404(req, res, next) {
  res.status(404).json({err: 'not found'});
}
/*
 * Generic error handling middleware.
 * Send back a 500 page and log the error to the console.
 */
function handleError(err, req, res, next) {
  console.error(err.stack);
  res.status(500).json({err: err.message});
}
/*
 * Store the db connection and start listening on a port.
 */
function startExpress(connection) {
  app._rdbConn = connection;
  var server = app.listen(config.express.port);
  io = require('socket.io')(server);
  console.log('Listening at ' +ip.address()+ ' on port ' + config.express.port);
  var options = {
  host: 'api.ipify.org',
  port: 80,
  path: '/?format=json',
  method: 'GET'
  };
http.request(options, function(res) {
  res.setEncoding('utf8');
  res.on('data', function (callback) {
    callback = JSON.parse(callback);
    console.log(callback.ip);
  });
}).end();
  io.sockets.on('connection', function(conn){
    socket = conn;
  })
}

/*
 * Connect to rethinkdb, create the needed tables/indexes and then start express.
 * Create tables/indexes then start express
 */
async.waterfall([
  function connect(callback) {
    r.connect(config.rethinkdb, callback);
  },
  function createDatabase(connection, callback) {
    //Create the database if needed.
    r.dbList().contains(config.rethinkdb.db).do(function(containsDb) {
      return r.branch(
        containsDb,
        {created: 0},
        r.dbCreate(config.rethinkdb.db)
      );
    }).run(connection, function(err) {
      callback(err, connection);
    });
  },
  function createSensorsTable(connection, callback) {
    //Create the sensors table if needed.
    r.tableList().contains('sensors').do(function(containsTable) {
      r.table('sensors').changes().run(connection, function(err, cursor) { //changefeed
        cursor.each(function(err, row) {
          if (err) throw err;
          var change = row.new_val;
          socket.emit('update', change);
          console.log("Changefeed socket sent for "+change.name);
   });
  });
      return r.branch(
        containsTable,
        {created: 0},
        r.tableCreate('sensors')
      );
    }).run(connection, function(err) {
      callback(err, connection);
    });
  },
  function createActionsTable(connection, callback) {
    //Create the actions table if needed.
    r.tableList().contains('actions').do(function(containsTable) {
      return r.branch(
        containsTable,
        {created: 0},
        r.tableCreate('actions')
      );
    }).run(connection, function(err) {
      callback(err, connection);
    });
  },
  function createIndex(connection, callback) {
  //Create the index if needed.
  r.table('sensors').indexList().contains('createdAt').do(function(hasIndex) {
    return r.branch(
      hasIndex,
      {created: 0},
      r.table('sensors').indexCreate('createdAt')
    );
  }).run(connection, function(err) {
    callback(err, connection);
  });
},
function waitForIndex(connection, callback) {
  //Wait for the index to be ready.
  r.table('sensors').indexWait('createdAt').run(connection, function(err, result) {
    callback(err, connection);
  });
}
], function(err, connection) {
  if(err) {
    console.error(err);
    process.exit(1);
    return;
  }

  startExpress(connection);
});
