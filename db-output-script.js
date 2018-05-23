//use constellation;

print("collabid,milestone,modified,grader,score,comment");

var cursor = db.checkoffs.find({
  'project': 'ic13-debugging',
  //'milestone': 'reducetestcase',
  //'cutoff': '2018-03-07T11:24:00',
});
cursor.forEach(function(result) {
  print(result.collabid + ","+
        result.milestone+","+
        result.modified+","+
        result.grader+","+
        result.score+","+
        result.comment);
});