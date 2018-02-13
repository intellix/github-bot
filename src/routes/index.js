const express = require('express');
const router = express.Router();

let log = [];

router.post('/', function (req, res) {
  log.push(req.body);
  res.json({ status: 'Up and running ' });
});

router.get('/log', function (req, res) {
  res.json({ log });
});

module.exports = router;
