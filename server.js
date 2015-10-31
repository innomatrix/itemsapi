'use strict';

var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var gzip = require('compression');
var nconf = require('nconf');
var port = nconf.get('server').port;
var _ = require('underscore');
var router = express.Router();
var cors = require('cors');
var server;
var httpNotFound = 404;
var httpBadRequest = 400;
var Promise = require('bluebird');


app.locals.environment = process.env.NODE_ENV || 'development'; // set env var
app.disable('etag');
app.disable('x-powered-by');
app.use(gzip({treshold: 512}));
app.use(bodyParser.json({
  limit: '4mb'
}));
app.use(cors());
app.use('/api/item', router);

var elastic = require('./src/connections/elastic');
elastic.init();

var configHelper = require('./src/helpers/config')(nconf.get());
var mappingHelper = require('./src/helpers/mapping');
var collectionsNames = configHelper.collectionsNames();
var dataService = Promise.promisifyAll(require('./src/services/data'));
var projectService = Promise.promisifyAll(require('./src/services/project'));
var elasticMapping = Promise.promisifyAll(require('./src/elastic/mapping'));
var searchService = Promise.promisifyAll(require('./src/services/search'));
var statsService = Promise.promisifyAll(require('./src/services/stats'));

var client = require('redis').createClient()
var limiter = require('express-limiter')(router, client)

// this is only temporary - finally it should goes to load balancer
limiter({
  path: '*',
  method: 'get',
  //lookup: 'connection.remoteAddress',
  lookup: 'headers.x-forwarded-for',
  total: 120,
  expire: 1000 * 60 * 2,
  //expire: 1000 * 60 * 60,
  onRateLimited: function (req, res, next) {
    next({ message: 'Rate limit exceeded', status: 429 })
  }
})

/*
 * get collections
 */
router.get('/collections', function getCollections(req, res, next) {
  var current = Promise.resolve();
  return Promise.map(collectionsNames, function(name) {
    return projectService.collectionInfoAsync({
      projectName: 'project',
      collectionName: name
    }).then(function(result) {
      return _.extend(result, {
        author: 'itemsapi'
      });
    }).catch(function(result) {
      return null;
    })
  }).then(function(result) {
    return _.filter(result, function(val) {
      return val !== null && val.count > 0 && val.visibility !== 'private';
    })
  }).then(function(result){
    return res.json({
      meta: {},
      pagination: {
        page: 1,
        per_page: 10,
        total: result.length
      },
      data: {
        items: result
      }
    });
  });
});

/*
 * get stats
 */
router.get('/stats', function getStats(req, res, next) {
  statsService.statsAsync({
    projectName: 'project'
  })
  .then(function(result) {
    return res.json(result);
  })
});

for (var i = 0 ; i < collectionsNames.length ; ++i) {
  var name = collectionsNames[i];

  // Immediately-invoked function expression
  (function(name) {

    /*
     * create specific item
     */
    router.post('/' + name, function postItem(req, res, next) {
      var processAsync;

      if (_.isArray(req.body)) {
        processAsync = dataService.addDocumentsAsync({
          projectName: 'project',
          collectionName: name,
          body: req.body
        });
      } else {
        processAsync = dataService.addDocumentAsync({
          projectName: 'project',
          collectionName: name,
          body: req.body
        });
      }

      return processAsync.then(function(result) {
        return res.json(result);
      }).catch(function(result) {
        return next(result);
      })
    });

    /*
     * get specific item
     */
    router.get('/' + name + '/id/:id', function getItem(req, res, next) {
      var id = req.params.id;

      dataService.getDocument({
        projectName: 'project',
        collectionName: name,
        id: id
      }, function afterGet(error, result) {
        if (error) {
          //return res.status(httpNotFound).json(error);
          return next(error);
        }
        return res.json(result);
      });
    });

    /*
     * clean items
     */
    router.put('/' + name + '/recreate-mapping', function recreateMapping(req, res, next) {
      elasticMapping.deleteMappingAsync({
        index: 'project',
        type: name
      })
      .then(function(result) {
        return projectService.addMappingAsync({
          projectName: 'project',
          collectionName: name
        })
      })
      .then(function(result) {
        return res.json({});
      }).catch(function(result) {
        return next(result);
      })
    });

    /*
     * clean items
     */
    router.delete('/' + name, function deleteItem(req, res, next) {
      dataService.cleanDocumentsAsync({
        projectName: 'project',
        collectionName: name
      }).then(function(result) {
        return res.json({});
      }).catch(function(result) {
        return next(result);
      })
    });

    /*
     * delete specific item
     */
    router.delete('/' + name + '/id/:id', function deleteItem(req, res, next) {
      var id = req.params.id;

      dataService.deleteDocument({
        projectName: 'project',
        collectionName: name,
        id: id
      }, function afterDelete(error, result) {
        if (error) {
          return next(error);
        }
        return res.json(result);
      });
    });

    /*
     * update specific item
     */
    router.put('/' + name + '/id/:id', function updateItem(req, res, next) {
      var id = req.params.id;

      dataService.updateDocument({
        projectName: 'project',
        collectionName: name,
        id: id,
        body: req.body
      }, function afterUpdate(error, result) {
        if (error) {
          return next(error);
        }
        return res.json(result);
      });
    });

    /*
     * search items
     */
    router.get('/' + name + '/find', function getItems(req, res, next) {
      console.log('queries');


      var aggs = {};
      if (req.query.aggs) {
        aggs = JSON.parse(req.query.aggs);
      }
      //console.log(req.query.aggs);
      //console.log(aggs);

      var fields = req.query.fields;
      if (fields !== undefined) {
        fields = fields.split(",");
      }

      // it should goes to configuration files
      var per_page = req.query.per_page || 10;
      if (per_page > 20) {
        per_page = 20;
      }

      // it should goes to configuration files
      var page = req.query.page || 1;
      if (page > 10) {
        page = 10;
      }

      var time = Date.now();

      // @todo filtering params
      searchService.search({
        projectName: 'project',
        collectionName: name,
        page: page,
        per_page: per_page,
        query: req.query.query || '',
        sort: req.query.sort || '',
        aggs: aggs,
        fields: fields
      }, function afterSearch(error, result) {
        if (error) {
          return next(error);
        }
        result.meta.search_time = Date.now() - time;
        return res.json(result);
      });
    });

    /*
     * collection info (schema, table, etc)
     */
    router.get('/' + name + '/metadata', function getCollectionInfo(req, res, next) {
      return res.json({
        metadata: configHelper.getMetadata(name)
      });
    });

    /*
     * mapping
     */
    router.get('/' + name + '/mapping', function getMapping(req, res, next) {
      return res.json({
        mapping: configHelper.getMapping(name)
      });
    });

    /*
     * get similar items
     */
    router.get('/' + name + '/:id/similar', function getSimilarItems(req, res, next) {
      var id = req.params.id;

      if (!id) {
        return res.status(httpNotFound).json({});
      }
      res.json({});
    });

    /*
     * item autocomplete
     */
    router.get('/' + name + '/autocomplete', function autocomplete(req, res, next) {
      // @todo filtering params
      searchService.suggest({
        projectName: 'project',
        collectionName: name,
        query: req.query.query || ''
      }, function afterSuggest(error, result) {
        if (error) {
          return next(error);
        }
        return res.json(result);
      });
    });

    /**
     * find nearest items to provided current gps
     */
    router.get('/' + name + '/near/:key/:gps', function autocomplete(req, res, next) {
      res.json({});
    });

  })(name);
}


app.use(function errorRoute(err, req, res, next) {
  console.log(err);
  res.status(httpBadRequest).json(err);
  next();
});


/**
 * start server
 */
exports.start = function start(done) {
  server = app.listen(port, function afterListen() {
    done(server);
  });
};


/**
 * stop server
 */
exports.stop = function start() {
  server.close();
};

exports.app = app;
