var Promise       = require('promise');
var request       = require('superagent');
var fs            = require('fs');
var mime          = require('mime');
var debug         = require('debug')('taskrun');
var _             = require('lodash');

// Get port and port from environment variables
var host = process.env.QUEUE_HOST;
var port = process.env.QUEUE_PORT;

// Check if QUEUE_HOST and QUEUE_PORT was defined
if (host === undefined || port === undefined) {
  throw new Error("$QUEUE_HOST and $QUEUE_PORT must be defined!")
}

/** Get a URL for an API end-point on the queue */
var queueUrl = function(path) {
  return 'http://' + host + ':' + port + '/v1' + path;
};

/**
 * Minimum time remaining until `takenUntil` expires before reclaim is
 * initialized, if `keepTask()` is used.
 */
var RECLAIM_TIME = 1000 * 60 * 3;

/**
 * Create a new TaskRun instance, this class help you keep a task run, upload
 * artifacts, supply `logs.json` and report result when the task is completed.
 */
var TaskRun = function(owner, task, status, runId, logsPutUrl, resultPutUrl) {
  this._owner                 = owner;
  this._status                = status;
  this._task                  = task;
  this._runId                 = runId;
  this._logsPutUrl            = logsPutUrl;
  this._resultPutUrl          = resultPutUrl;
  this._reclaimTimeoutHandle  = null;
};

/**
 * Reclaim task for current run, returns a promise of success
 *
 * **Note**, consider using `keepTask()` and `clearKeepTask()` instead of
 * reimplementing the timing logic.
 */
TaskRun.prototype.reclaimTask = function() {
  var that = this;
  var taskId = that._status.taskId;
  return new Promise(function(accept, reject) {
    var url = queueUrl('/task/' + taskId + '/claim');
    request
      .post(url)
      .send({
        workerGroup:      that.owner.workerGroup,
        workerId:         that.owner.workerId,
        runId:            that._runId
      })
      .end(function(res) {
        if (res.ok) {
          debug("Successfully, reclaimed task: %s", taskId);
          that._status        = res.body.status;
          that._logsPutUrl    = res.body.logsPutUrl;
          that._resultPutUrl  = res.body.resultPutUrl;
          accept();
        } else {
          debug("Failed to reclaim task: %s", taskId);
          reject();
        }
      });
  });
};

/**
 * Keep task by reclaiming task from queue before `takenUntil` expires,
 * until `taskCompleted()` or `clearKeepTask()` is called.
 *
 * The optional argument `abortCallback` will be called if a reclaim fails.
 */
TaskRun.prototype.keepTask = function(abortCallback) {
  var that = this;
  var setReclaimTimeout = function() {
    that._reclaimTimeoutHandle = setTimeout(function() {
      that.reclaimTask().then(setReclaimTimeout, function() {
        // TODO: This is a little aggressive, we should allow it to fail a few
        // times before we abort... And we should check the error code, 404
        // Task not found, means task completed or canceled, in which case we
        // really should abort immediately
        if (abortCallback) {
          abortCallback();
        }
      });
    },
      (new Date(that._status.takenUntil)).getTime() -
      (new Date()).getTime() - RECLAIM_TIME
    );
  };
};

/** Stop reclaiming from the queue before `takenUntil` expires */
TaskRun.prototype.clearKeepTask = function() {
  if(this._reclaimTimeoutHandle) {
    clearTimeout(this._reclaimTimeoutHandle);
    this._reclaimTimeoutHandle = null;
  }
};

/**
 * Returns task status from cache
 */
TaskRun.prototype.status = function() {
  return _.cloneDeep(this._status);
};

/** Get task definition from cache */
TaskRun.prototype.task = function() {
  return _.cloneDeep(this._task);
};

/** Put logs.json for current run, returns promise of success */
TaskRun.prototype.putLogs = function(json) {
  var that = this;
  return new Promise(function(accept, reject) {
    debug("Uploading logs.json to signed PUT URL");
    request
      .put(that._logsPutUrl)
      .send(json)
      .end(function(res) {
        if(res.ok) {
          debug("Successfully, uploaded logs.json");
          accept();
        } else {
          debug("Failed to upload logs.json, error: %s", res.text)
          reject();
        }
      });
  });
};

/** Put result.json for current run, returns promise of success */
TaskRun.prototype.putResult = function(json) {
  var that = this;
  return new Promise(function(accept, reject) {
    debug("Uploading result.json to PUT URL");
    request
      .put(that._resultPutUrl)
      .send(json)
      .end(function(res) {
        if(res.ok) {
          debug("Successfully, uploaded result.json");
          accept();
        } else {
          debug("Failed to upload logs.json, error: %s", res.text)
          reject();
        }
      });
  });
};

/**
 * Put artifact from file, returns promise for a URL to the uploaded artifact
 *
 * If the optional contentType isn't provided, Content-Type will be deduced from
 * filename.
 */
TaskRun.prototype.putArtifact = function(name, filename, contentType) {
  var that = this;
  return new Promise(function(accept, reject) {
    // Test that specified file exists
    var stat = fs.statSync(filename);
    if (!stat.isFile()) {
      throw new Error("No such file: " + filename);
    }

    // Lookup mimetype if not provided
    if (!contentType) {
      contentType = mime.lookup(filename);
    }

    // Create artifacts map to submit
    var artifacts = {};
    artifacts[name] = {
      contentType:       contentType
    };

    // Construct request URL for fetching signed artifact PUT URLs
    var url = queueUrl('/task/' + that._status.taskId + '/artifact-urls');

    // Request artifact put urls
    request
      .post(url)
      .send({
        workerGroup:      that.owner.workerGroup,
        workerId:         that.owner.workerId,
        runId:            that._runId,
        artifacts:        artifacts
      })
      .end(function(res) {
        if (res.ok) {
          debug("Got signed artifact PUT URL from queue");
          var req = request
                      .put(res.body.artifactPutUrls[name])
                      .set('Content-Type',    contentType)
                      .set('Content-Length',  stat.size);
          fs.createReadStream(filename).pipe(req, {end: false});
          req.end(function(res) {
            if (res.ok) {
              debug("Successfully uploaded artifact %s to PUT URl", name);
              var artifactUrl = 'http://tasks.taskcluster.net/' +
                                that._status.taskId + '/runs/' + that._runId +
                                '/artifacts/' + name;
              accept(artifactUrl);
            } else {
              debug("Failed to upload to signed artifact PUT URL");
              reject();
            }
          });
        } else {
          debug("Failed get a signed artifact URL, errors: %s", res.text);
          reject();
        }
      });
  });
};

/** Report task completed, returns promise of success */
TaskRun.prototype.taskCompleted = function() {
  this.clearKeepTask();
  var that = this;
  return new Promise(function(accept, reject) {
    var url = queueUrl('/task/' + that._status.taskId + '/completed');
    request
      .post(url)
      .send({
        workerGroup:      that.owner.workerGroup,
        workerId:         that.owner.workerId,
        runId:            that._runId
      })
      .end(function(res) {
        if(res.ok) {
          debug("Successfully reported task completed");
          accept();
        } else {
          debug("Failed to report task as completed, error code: %s", res.status);
          reject();
        }
      });
  });
};

// Export TaskRun
module.exports = TaskRun;