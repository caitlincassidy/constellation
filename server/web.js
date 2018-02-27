const bodyparser = require('body-parser');
const crypto = require('crypto');
const diff = require('diff');
const enchilada = require('enchilada');
const events = require('events');
const express = require('express');
const fs = require('fs');
const moment = require('moment');
const mongodb = require('mongodb');
const pug = require('pug');
const child_process = require('child_process');
const sharedb = require('sharedb')

const logger = require('./logger');

exports.createFrontend = function createFrontend(config, db) {
  
  const log = logger.log.child({ in: 'app' });

  const join = require('./join').create(config);
  const paired = new events.EventEmitter();
  const setupproject = 'constellation-setup';
  
  const app = express();
  
  app.set('view engine', 'pug');
  app.set('views', `${__dirname}/views`);
  app.set('x-powered-by', false);
  
  app.use('/public', enchilada(`${__dirname}/public`));
  app.use('/static', express.static(`${__dirname}/static`));
  app.use(bodyparser.json());
  
  app.use(logger.express(log));
  
  app.locals.config = config;
  app.locals.moment = moment;
  
  // validate parameter against anchored regex
  function validate(regex) {
    let anchored = new RegExp('^' + regex.source + '$');
    return function(req, res, next, val) {
      if (anchored.test(val)) { next(); } else { next('route'); }
    };
  }
  
  app.param('project', validate(/[\w-]+/));
  app.param('userid', validate(/\w+/));
  app.param('collabid', validate(/[0-9a-f]{24}/));
  app.param('milestone', validate(/\w+/));
  app.param('cutoff', validate(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/));
  
  function authenticate(req, res, next) {
    let cert = req.connection.getPeerCertificate();
    if ( ! req.connection.authorized) {
      return res.status(401).render('401', {
        error: req.connection.authorizationError,
        cert
      });
    }
    
    res.locals.authusername = cert.subject.emailAddress.replace('@' + config.web.certDomain, '');
    if (config.web.userFakery) {
      res.locals.authusername += '+' +
        crypto.createHash('md5').update(req.headers['user-agent']).digest('hex').substr(0, 3);
    }
    res.locals.authstaff = config.staff.indexOf(res.locals.authusername) >= 0;
    res.set('X-Authenticated-User', res.locals.authusername);
    
    res.locals.shareURL = `wss://${req.hostname}:${config.web.wss}/${db.usernameToken(res.locals.authusername)}`;
    
    next();
  }
  
  function collaboration(req, res, next) {
    db.getUser(res.locals.authusername, function(err, user) {
      res.locals.collabid = user.data && user.data.collabs.length && user.data.collabs[0];
      next();
    });
  }
  
  function staffonly(req, res, next) {
    if ( ! res.locals.authstaff) {
      return res.status(401).render('401', { error: 'Permission denied' });
    }
    next();
  }
  
  function authorize(req, res, next) {
    if (res.locals.authstaff) { return next(); }
    db.getCollab(req.params.collabid, function(err, collab) {
      if (err || collab.data.users.indexOf(res.locals.authusername) < 0) {
        return res.status(401).render('401', { error: 'Permission denied' });
      }
      next();
    });
  }
  
  app.get('/', authenticate, collaboration, function(req, res, next) {
    res.render('index');
  });
  
  app.get('/pair/:project/:id', authenticate, function(req, res, next) {
    if (req.params.project == setupproject) {
      return res.render('setup-join');
    }
    
    res.render('join', {
      project: req.params.project,
      joincode: join.code({ username: res.locals.authusername, project: req.params.project }),
    });
  });
  
  app.post('/pair/:project/:userid', authenticate, function(req, res, next) {
    let me = res.locals.authusername;
    let token = db.usernameToken(res.locals.authusername);
    
    if (req.params.project == setupproject) {
      db.recordSetup(me, function(err) {
        if (err) { log.warn({ err }, 'Error recording user setup'); }
      });
      paired.emit(req.params.userid, { me, token });
      return res.send({ redirect: '/setup-done' });
    }
    
    join.rendezvous(req.body.me, req.body.partner, function(err, agreed) {
      if (err) { return res.status(400).send({ error: err.message }); }
      
      if (res.locals.authusername == agreed.partner.username) {
        return res.status(400).send({ error: 'Cannot pair with yourself' });
      }
      if (agreed.me.project !== agreed.partner.project) {
        return res.status(400).send({ error: 'Different projects selected' });
      }
      
      let partner = agreed.partner.username;
      let project = agreed.me.project;
      let collabid = agreed.id;
      
      db.addUserToCollaboration(me, project, collabid, function(err) {
        paired.emit(req.params.userid, { me, token, partner, project, collabid });
        res.send({ redirect: '/edit' });
      });
    });
  });
  
  app.get('/setup-done', authenticate, function(req, res, next) {
    res.render('setup-done');
  });
  
  app.get('/edit', authenticate, collaboration, function(req, res, next) {
    if ( ! res.locals.collabid) {
      return res.status(400).render('400', { error: 'No current collaboration' });
    }
    res.render('files');
  });
  
  app.get('/edit/:filepath(*)', authenticate, collaboration, function(req, res, next) {
    if ( ! res.locals.collabid) {
      return res.status(400).render('400', { error: 'No current collaboration' });
    }
    res.render('edit', {
      filepath: req.params.filepath,
    });
  });
  
  app.get('/show/:project/:collabid/:cutoff', authenticate, function(req, res, next) {
    res.render('collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      cutoff: req.params.cutoff,
    });
  });
  
  app.get('/show/:project/:collabid/m/:milestone', authenticate, function(req, res, next) {
    res.render('collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      milestone: req.params.milestone,
    });
  });
  
  app.get('/dashboard', authenticate, staffonly, function(req, res, next) {
    db.getProjects(function(err, projects) {
      res.render('dashboard/projects', {
        projects,
      });
    });
  });
  
  app.get('/dashboard/:project/:cutoff?', authenticate, staffonly, function(req, res, next) {
    if (req.params.project == setupproject) {
      return db.getSetups(req.params.cutoff, function(err, setups) {
        if (err) { return res.status(400).send({ error: err.message }); }
        res.attachment('constellation-setups.csv');
        res.render('dashboard/setups-csv', { setups });
      });
    }

    res.render('dashboard/collabs', {
      project: req.params.project,
      cutoff: req.params.cutoff,
      visual: req.query.visual,
    });
  });
  
  app.get('/dashboard/:project/checkoffs:csv(.csv)?', authenticate, staffonly, function(req, res, next) {
    db.getCheckoffs(req.params.project, function(err, milestones, users) {
      if (req.params.csv) {
        res.attachment(`constellation-checkoffs-${req.params.project}.csv`);
        res.locals.url = `https://${req.hostname}${config.web.https != 443 ? `:${config.web.https}` : ''}`;
      }
      res.render(req.params.csv ? 'dashboard/checkoffs-csv' : 'dashboard/checkoffs', {
        project: req.params.project,
        milestones,
        users,
      });
    });
  });
  
  app.get('/dashboard/:project/live/m/:milestone', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/pings', {
      project: req.params.project,
      milestone: req.params.milestone,
    });
  });
  
  app.get('/dashboard/:project/m/:milestone/:cutoff?/:regexes?', authenticate, staffonly, function(req, res, next) {

    res.render('dashboard/collabs', {
      project: req.params.project,
      milestone: req.params.milestone,
      cutoff: req.params.cutoff,
      visual: req.query.visual,
    });
  });
  
  app.get('/dashboard/:project/:collabid/:cutoff?', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      cutoff: req.params.cutoff,
      visual: req.query.visual,
    });
  });
  
  // TODO: Get URL with regex but no cutoff to work
  app.get('/dashboard/:project/:collabid/m/:milestone/:cutoff?/:regexes?', authenticate, staffonly, function(req, res, next) {
    res.render('dashboard/collab', {
      project: req.params.project,
      collabid: req.params.collabid,
      milestone: req.params.milestone,
      cutoff: req.params.cutoff,
      visual: req.query.visual,
    });
  });
  
  app.get('/baseline/:project/:filepath(*)', authenticate, staffonly, function(req, res, next) {
    
    db.getBaseline(req.params.project, req.params.filepath, function(err, baseline) {
      if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
      res.type('text/plain');
      res.setHeader('Cache-Control', 'max-age=3600');
      res.send(baseline);
    });
  });

  // Find the given regex in the text, using fuzzy matching
  // TODO: Better URL?
  app.get('/regex/:collabid/:regexes/:cutoff?/f/:filepath(*)', authenticate, staffonly,  function(req, res, next) {
    // TODO: When a regex like '%5C%28.%2A%5C%29'; // \(.*\)
    //   comes through a URL directly instead of set as a string
    //   in collab.js, the regex is not processed correctly:
    //   filepath: src/SquareClient.java//(.*
    //   regex: )

    // TODO: Typing \(.*\) in URL bar doesn't encode the \ or the ()

    if (req.params.cutoff) {
      db.getHistorical(req.params.collabid, req.params.filepath, moment(req.params.cutoff), function(err, historical) {
        if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
        var regexesMap = getRegexesMap(historical.data.text, req.params.regexes);
        res.send(JSON.stringify([...regexesMap]));
      });
    } else {
      db.getFile(req.params.collabid, req.params.filepath, function(err, file) {
        if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
        var regexesMap = getRegexesMap(file.text, req.params.regexes);
        res.send(JSON.stringify([...regexesMap]));
      });
    }
  });
  
  app.get('/historical/:project/:collabid/:filepath(*)/:cutoff', authenticate, authorize, function(req, res, next) {
    db.getHistorical(req.params.collabid, req.params.filepath, moment(req.params.cutoff), function(err, historical) {
      if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
      res.setHeader('Cache-Control', 'max-age=3600');
      res.send(historical);
    });
  });

  // TODO: Better way to take in the cutoff than as a '?cutoff='' ?
  app.get('/ops/:project/:collabid/:filepath(*)', authenticate, staffonly, function(req, res, next) {
    db.getOps(req.params.collabid, req.params.filepath, req.query.cutoff, function(err, ops) {
      if (err) { return res.status(500).send({ code: err.code, message: err.message }); }
      var chunkedDiffs = getChunkedDiffs(ops, req.query.threshold);
      var mergedDiffs = mergeDiffs(chunkedDiffs);
      res.setHeader('Cache-Control', 'max-age=3600');
      res.send(mergedDiffs);
    });
  })
  
  app.get('/hello/:version', function(req, res, next) {
    getPluginVersion(function(err, version) {
      res.send({
        update: req.params.version < version ? version : undefined,
        userid: mongodb.ObjectID().toString(),
      });
    });
  });
  
  app.get('/await-collaboration/:userid', function(req, res, next) {
    let send = settings => res.send(settings);
    paired.once(req.params.userid, send);
    setTimeout(() => paired.removeListener(req.params.userid, send), 1000 * 60 * 15);
  });
  
  app.get('/install', function(req, res, next) {
    getPluginVersion(function(err, version) {
      if (err) {
        return res.status(400).render('400', { error: 'Install server not configured' });
      }
      let protocol = config.web.httpUpdateSite ? 'http' : 'https';
      let port = config.web.httpUpdateSite ? `:${config.web.httpUpdateSite}`
                                           : config.web.https != 443 ? `:${config.web.https}` : '';
      res.render('install', {
        version,
        url: `${protocol}://${req.hostname}${port}${req.path}`
      });
    });
  });
  
  app.use('/install', express.static(`${__dirname}/install`));
  
  app.createUpdateSite = function createUpdateSite() {
    const app = express();
    app.use('/install', express.static(`${__dirname}/install`));
    return app;
  };
  
  app.get('/update/:oldversion', function(req, res, next) {
    getPluginVersion(function(err, version) {
      if (err) {
        return res.status(400).render('400', { error: 'Install server not configured' });
      }
      res.render('update', {
        oldversion: req.params.oldversion.split('.', 3).join('.'),
        version,
      });
    });
  });
  
  app.get('*', function(req, res, next) {
    res.status(404).render('404');
  });
  
  return app;
};

// get the plug-in version without qualifier
function getPluginVersion(callback) {
  fs.readFile(`${__dirname}/install/version.txt`, { encoding: 'utf8' }, function(err, version) {
    callback(err, version && version.trim().split('.', 3).join('.'));
  });
}

function getRegexesMap(fileText, regexes) {
  // Regex matching: https://laurikari.net/tre/about/
  // TODO: Add 'apt-get install tre-agrep libtre5 libtre-dev'
  //   to a setup script somewhere?

  var regexesMap = new Map();

  // tre-agrep doesn't require that you only give it one line at a time
  // However, tre-agrep only finds the first instance of regex in each line,
  //   and we want to find all instances of each regex in each line.
  // So, we split the file by line and find multiple regexes (if they exist)
  //   for each line individually.
  var fileLines = fileText.split("\n");
  var regexesList = regexes.split(";;");

  for (let lineNumber = 1; lineNumber < fileLines.length + 1; lineNumber++) {
    // ';;' is the delimiter between regexes
    regexesList.forEach(function(regex) {
      if (regex.length > 0) {

        // Keeps track of what part of the line we start at, since if we're finding
        // multiple of the same regex in the same line, we need to cut off the first
        //   part of the line
        var indexInLine = 0;

        while (indexInLine < fileLines[lineNumber-1].length) {

          var result = child_process.spawnSync('tre-agrep',
            ['--show-position', '--line-number', '--regexp', regex, '-'],
            {'input': fileLines[lineNumber - 1].substring(indexInLine)}
          );

          var mapValue = getRegexLocationAndLength(result.stdout);
          if (mapValue) {
            // Then we got a regex match

            // Its actual indexInLine from the start of the entire line
            //   depends on where our substring started (indexInLine)
            mapValue["indexInLine"] = indexInLine + mapValue["indexInLine"];
            // Start the next substring from where this regex ends
            indexInLine = mapValue["indexInLine"] + mapValue["length"];

            if (regexesMap.has(lineNumber)) {
              regexesMap.set(lineNumber, regexesMap.get(lineNumber).concat([mapValue]));
            } else {
              regexesMap.set(lineNumber, [mapValue]);
            }  
          } else {
            // If no mapValue, there are no more regexes on this line
            // so we're done with the while loop
            break;
          }


        }

        
      }
    });
  }

  return regexesMap;
}

/** Get the location within a line and length of a regex match,
 * given the result of a tre-agrep call */
function getRegexLocationAndLength(stdout) {
  if (!stdout) {
    return;
  }

  // stdout returns ASCII numbers, so convert them to strings
  var resultString = '';
  stdout.forEach(function(num) {
    resultString += String.fromCharCode(num);
  });

  var values = resultString.split(':');
  if (values.length < 3) {
    // Not a legitimate match
    return;
  }

  var lineNumber = parseInt(values[0]);
  var relevantChars = values[1];
  var indices = relevantChars.split('-');
  var indexInLine = parseInt(indices[0]);
  // Note: If *, only includes the len of things before the *
  //   haven't tested if you have abc*xyz as the regex yet
  var lengthToHighlight = parseInt(indices[1]) - parseInt(indices[0]);

  var mapValue = {
    'indexInLine': indexInLine,
    'length': lengthToHighlight
  };

  return mapValue;
}


function getChunkedDiffs(ops, threshold) {
    if (!threshold) {
      threshold = 10000;
    }
    // TODO: Very large threshold => no results

    // If there have been no changes to the document,
    // ops = {v:0}
    if (!Array.isArray(ops)) {
      return [];
    }

    var chunkedDiffs = [];

    /* Setup the baseline of the document */ 
    var firstOp = ops[0];


    // The baseline for the next diff
    var currentBaseline = {v:0};
    sharedb.ot.apply(currentBaseline, firstOp);
    // The doc to apply ops to
    var currentDoc = {v:0};
    sharedb.ot.apply(currentDoc, firstOp);

    var lastTs = firstOp.m.ts;

    // Create a diff for the first part, so that
    // we can track original code
    var baseDiff = diff.diffLines(currentBaseline.data.text.trim(), currentBaseline.data.text.trim());
    baseDiff.forEach(function(part) {
      // Note: should only be one part
      part.original = true;
    });

    chunkedDiffs.push(baseDiff);

    /* Apply each op, and calculate a diff if two 
       consecutive ops are far enough apart */
    for (var i = 1; i < ops.length; i++) {
      var op = ops[i];

      // Start a new chunk if necessary
      if (op.m.ts - lastTs > threshold) {
        var chunkedDiff = diff.diffLines(
          currentBaseline.data.text.trim(), currentDoc.data.text.trim());
        
        // Only push diffs with changes
        if (!(chunkedDiff.length == 1 && 
            !chunkedDiff[0].added &&
            !chunkedDiff[0].removed)) {
          chunkedDiffs.push(chunkedDiff);
        }

        // Make a deep copy
        currentBaseline = JSON.parse(JSON.stringify(currentDoc));
        
      }

      // Apply the op
      let err = sharedb.ot.apply(currentDoc, op);
      if (err) {
        // TODO: Better error handling
        console.log("err when applying op:" + JSON.stringify(err));
        return;
      }
         
      lastTs = op.m.ts;
    }

    // Add the last diff
    var chunkedDiff = diff.diffLines(
      currentBaseline.data.text.trim(), currentDoc.data.text.trim());

    // Only push diffs with changes
    if (!(chunkedDiff.length == 1 &&
        !chunkedDiff[0].added &&
        !chunkedDiff[0].removed)) {
      chunkedDiffs.push(chunkedDiff);
    }


    return chunkedDiffs; 
}

// TODO: Simplify
// TODO: Remove parts with '' at the end

/**
 * Merges the given list of diffs into a total diff,
 * maintaining the inserts and deletes that happened
 * in each diff.
 */
function mergeDiffs(diffs) {
  if (diffs.length == 0) {
    return diffs;
  }

  mergedDiff = JSON.parse(JSON.stringify(diffs[0]));
  for (var i = 1; i < diffs.length; i++) {
    var diff = JSON.parse(JSON.stringify(diffs[i]));

    // Index into mergedDiff for what chunk we're currently on
    var currentChunkInMerged = 0;

    // Index within the current chunk
    var indexInCurrentChunkInMerged = 0;

    diff.forEach(function(part) {

      if (part.added) {

        var currentChunk = mergedDiff[currentChunkInMerged];

        // Skip through the already removed chunks
        // This preserves order if I remove something,
        //   and then add something later in the same place
        while (currentChunk && currentChunk.removed) {
          currentChunkInMerged += 1;
          currentChunk = mergedDiff[currentChunkInMerged];
        }

        if (!currentChunk) {
          // The added part is at the very end of the file
          mergedDiff.push(part);

          // Our indexes are at the end of the last part
          currentChunkInMerged = mergedDiff.length;
          indexInCurrentChunkInMerged = part.value.length;

        } else {
          // Split up this chunk into previous and next
          var prevChunk = JSON.parse(JSON.stringify(currentChunk));
          prevChunk.value = prevChunk.value.substring(0, indexInCurrentChunkInMerged);
          var nextChunk = JSON.parse(JSON.stringify(currentChunk));
          nextChunk.value = nextChunk.value.substring(indexInCurrentChunkInMerged);

          // Delete the current chunk and replace it with prev, part, and next
          mergedDiff.splice(currentChunkInMerged, 1, prevChunk, part, nextChunk);

          // Now, we start at the beginning of nextChunk
          currentChunkInMerged += 2;
          indexInCurrentChunkInMerged = 0;
        }    
        
      } else if (part.removed) {

        var currentChunk = mergedDiff[currentChunkInMerged];

        // Skip through the already removed chunks
        while (currentChunk && currentChunk.removed) {
          currentChunkInMerged += 1;
          currentChunk = mergedDiff[currentChunkInMerged];
        }

        if (indexInCurrentChunkInMerged + part.value.length < currentChunk.value.length) {
          // The remove is within a single chunk
          var prevChunk = JSON.parse(JSON.stringify(currentChunk));
          prevChunk.value = prevChunk.value.substring(0, indexInCurrentChunkInMerged);
          var deletedChunk = JSON.parse(JSON.stringify(currentChunk));
          deletedChunk.value = deletedChunk.value.substring(indexInCurrentChunkInMerged, indexInCurrentChunkInMerged + part.value.length);
          deletedChunk.removed = true;
          deletedChunk.added = false;
          var nextChunk = JSON.parse(JSON.stringify(currentChunk));
          nextChunk.value = nextChunk.value.substring(indexInCurrentChunkInMerged + part.value.length);

          // Delete the current chunk and replace it
          mergedDiff.splice(currentChunkInMerged, 1, prevChunk, deletedChunk, nextChunk);

          // Starting at the beginning of nextChunk
          currentChunkInMerged += 2;
          indexInCurrentChunkInMerged = 0;

        } else {
          // The remove goes over multiple chunks

          // Split the first chunk into a normal part and deleted part
          var normalChunk = JSON.parse(JSON.stringify(currentChunk));
          normalChunk.value = normalChunk.value.substring(0, indexInCurrentChunkInMerged);
          var firstDeletedChunk = JSON.parse(JSON.stringify(currentChunk));
          firstDeletedChunk.value = firstDeletedChunk.value.substring(indexInCurrentChunkInMerged);
          firstDeletedChunk.removed = true;
          firstDeletedChunk.added = false;

          // TODO: Remove parts with '' value

          // Delete the current chunk and replace it with prev and next
          mergedDiff.splice(currentChunkInMerged, 1, normalChunk, firstDeletedChunk);

          // Start our while loop at the beginning of the next chunk
          currentChunkInMerged += 2;
          indexInCurrentChunkInMerged = 0;
          if (!mergedDiff[currentChunkInMerged]) {
            return;
          }

          var numSeenCharacters = 0;
          var numCharactersLeft = part.value.length - firstDeletedChunk.value.length;
          
          // Mark all chunks in the middle as removed
          // and find the chunk at the end that must be partially removed
          while (numSeenCharacters < numCharactersLeft) {
            var currentChunk = mergedDiff[currentChunkInMerged];
            if (currentChunk.removed) {
              // This chunk is not included this diff, so keep going
              currentChunkInMerged += 1;

            } else if (numSeenCharacters + currentChunk.value.length < numCharactersLeft) {
              // This whole chunk should be considered removed
              currentChunk.removed = true;
              currentChunk.added = false;
              numSeenCharacters = numSeenCharacters + currentChunk.value.length;
              currentChunkInMerged += 1;

            } else {
              // The last chunk is partly removed, partly not removed
              break;
            }
          }

          // Split last chunk, since remove might end
          // in the middle of a chunk
          currentChunk = mergedDiff[currentChunkInMerged];
          if (!currentChunk) {
            return;
          }
          
          // We have this many more characters to remove 
          numCharactersToDelete = numCharactersLeft - numSeenCharacters;

          var lastDeletedChunk = JSON.parse(JSON.stringify(currentChunk));
          lastDeletedChunk.value = lastDeletedChunk.value.substring(0, numCharactersToDelete);
          lastDeletedChunk.removed = true;
          lastDeletedChunk.added = false;
          var nextNormalChunk = JSON.parse(JSON.stringify(currentChunk));
          nextNormalChunk.value = nextNormalChunk.value.substring(numCharactersToDelete);


          // Delete the current chunk and replace it with prev and next
          mergedDiff.splice(currentChunkInMerged, 1, lastDeletedChunk, nextNormalChunk);

          // Start at the beginning of the normal chunk
          currentChunkInMerged += 1;
          indexInCurrentChunkInMerged = 0;

        }

        
      } else {
        // Part is not removed or added,
        // So we just need to change our currentChunkInMerged
        // and indexInCurrentChunkInMerged

        var currentChunk = mergedDiff[currentChunkInMerged];

        // Check if we stay in the same chunk after this part
        if (indexInCurrentChunkInMerged + part.value.length < currentChunk.value.length) {
          indexInCurrentChunkInMerged += part.value.length;
          return;
        }

        // Start out by going through the first chunk
        var numSeenCharacters = currentChunk.value.length - indexInCurrentChunkInMerged;
        
        currentChunkInMerged += 1;
        currentChunk = mergedDiff[currentChunkInMerged];
    
        // Find the chunk at the end
        while (currentChunk && numSeenCharacters < part.value.length) {
          if (currentChunk.removed) {
            // A removed chunk should not be counted, so keep going
            currentChunkInMerged += 1;

          } else if (numSeenCharacters + currentChunk.value.length < part.value.length) {
            // We can go completely through this chunk,
            // so move on to next chunk
            numSeenCharacters = numSeenCharacters + currentChunk.value.length;
            currentChunkInMerged += 1;

          } else {
            // We can't go through a whole chunk
            break;
          }
          currentChunk = mergedDiff[currentChunkInMerged];
        }

        indexInCurrentChunkInMerged = part.value.length - numSeenCharacters;
      }
    });
  }

  return mergedDiff;
}

/**
 * If the op added/deleted text, Return the op's
 *   text, type (insert or delete), and index at which
 *   the operation started in the file.
 * Otherwise, return null.
 */
function getOpText(op) {
  var textOrCursors = op.op[0].p[0];
  if (textOrCursors == 'text') {
    // Get type
    var type;
    var text;
    if (op.op[0].sd) {
      type = 'delete';
      text = op.op[0].sd;
    } else if (op.op[0].si) {
      type = 'insert';
      text = op.op[0].si;
    }

    if (text) {
      return {
        'index': op.op[0].p[1],
        'type': type,
        'text': text.split('')
      }
    }    
  }

  return null;
}

// Export for testing
exports.mergeDiffs = mergeDiffs;
