'use strict';
// electron-builder `afterSign`: VMP signing on Windows. See vmp-sign.js.
const { vmpSign } = require('./vmp-sign');
module.exports = async (context) => vmpSign('afterSign', context);
