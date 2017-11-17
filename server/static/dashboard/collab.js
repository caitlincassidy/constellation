var connection = new window.sharedb.Connection(new WebSocket(shareURL));

var collab = connection.get('collabs', collabid);
collab.fetch(function(err) {
  if (err) { throw err; }
  
  document.querySelector('#partners').textContent = collab.data.users.slice().sort().join(' & ')
});

connection.createFetchQuery('files', { collabid: collabid }, {}, function(err, files) {
  if (err) { throw err; }
  
  var list = document.querySelector('#files');
  files.sort(function(a, b) { return a.data.filepath.localeCompare(b.data.filepath); });
  files.forEach(function(file) {
    var item = document.importNode(document.querySelector('#file').content, true);
    var heading = item.querySelector('h4');
    heading.textContent = file.data.filepath;
    var diff = item.querySelector('.diff code');
    list.appendChild(item);
    
    $.ajax('/baseline/' + project + '/' + file.data.filepath).done(function(baseline) {
      if (cutoff) {
        $.ajax('/historical/' + project + '/' + collabid + '/' + file.data.filepath + '/' + cutoff).done(function(historical) {
          updateDiff(diff, baseline, historical.data ? historical.data.text : undefined, file);
        }).fail(function(req, status, err) {
          diff.textContent = 'Error fetching code: ' + errorToString(req.responseJSON, status, err);
        });
      } else {
        file.subscribe(function() {
          updateDiff(diff, baseline, file.data.text, file);
          file.on('op', function() {
            updateDiff(diff, baseline, file.data.text, file);
          });
        });
      }
    }).fail(function(req, status, err) {
      diff.textContent = 'Error fetching baseline: ' + errorToString(req.responseJSON, status, err);
    });

  });
});

// TODO: Don't need to pass in text if we get the whole file anyway
function updateDiff(node, baseline, text, file) {
  if (baseline === undefined || text === undefined) { return; }
  node.innerHTML = '';

  // ';;' is used as the delimiter between regexes

  // TODO: Don't call the regex URL if there are no regexes
  var allRegexes = regexes ? regexes : '@Override' + ';;' + 'void';

  //allRegexes = '%5C%28.%2A%5C%29'; // \(.*\)
  $.ajax('/regex/' + collabid + '/' + file.data.filepath + '/' + allRegexes).done(function(regexesJson) {
    var regexesMap = new Map(JSON.parse(regexesJson));

    // Keep track of the current line number we're on
    // TODO: -1 doesn't seem right
    var currentLineNumber = 1;

    // Calculate the diff and highlight it correctly
    window.diff.diffLines(baseline.trim(), text.trim()).forEach(function(part) {
      var partLines = part.value.split('\n');
      // Last one is always an empty string
      partLines.pop();

      //console.log(partLines);
      //console.log(part);
      for (var i = 0; i < partLines.length; i++) {
        var partLine = partLines[i];

        var elt = document.createElement('div');

        // A removed part doesn't count toward the line numbers
        if (part.removed) {
          elt.classList.add('diff-removed');
          node.appendChild(elt);
          //currentLineNumber += 1;
          continue;
        }

        if (regexesMap.has(currentLineNumber)) {

          var endOfLastRegex = 0;
          regexesMap.get(currentLineNumber).forEach(function(match) {
            if (endOfLastRegex > match.indexInLine) {
              // The regexes overlapped (e.g. 'Stream' and 'a')
              // Ignore this regex
              // TODO: Better handling of this case?
              //   Probably won't happen that much?
              return;
            }

            // TODO: Make more DRY

            var beforeRegexElt = document.createElement('span');
            var regexElt = document.createElement('span');
            var afterRegexElt = document.createElement('span');

            beforeRegexElt.appendChild(document.createTextNode(
              partLine.substring(endOfLastRegex, match.indexInLine)));
            regexElt.appendChild(document.createTextNode(
              partLine.substring(match.indexInLine, match.indexInLine + match.length)));
            afterRegexElt.appendChild(document.createTextNode(
              partLine.substring(match.indexInLine + match.length)));

            regexElt.classList.add('diff-regex');

            if (part.added) {
              beforeRegexElt.classList.add('diff-added');
              regexElt.classList.add('diff-added');
              afterRegexElt.classList.add('diff-added');
            }

            if (endOfLastRegex > 0) {
              // Need to remove the last child, since this the three elts
              // created here represent the same characters as the last child
              elt.removeChild(elt.lastChild);
            }

            elt.appendChild(beforeRegexElt);
            elt.appendChild(regexElt);
            elt.appendChild(afterRegexElt);

            endOfLastRegex = match.indexInLine + match.length;
          });

        } else {
          elt.classList.add('diff-part');
          if (part.added) {
            elt.classList.add('diff-added');
            elt.appendChild(document.createTextNode(partLine));
          } else {
            elt.appendChild(document.createTextNode(partLine));
          }

        }

        node.appendChild(elt);
        currentLineNumber += 1;
      }
      
    });

    // TODO: Syntax highlighting doesn't work anymore
    //hljs.highlightBlock(node);

    
    
  }).fail(function(req, status, err) {
    console.log("got regex error");
    console.log(err);
  });

  



}

function errorToString(json, status, err) {
  return (json && json.code || status) + ' ' + (json && json.message || err);
}
