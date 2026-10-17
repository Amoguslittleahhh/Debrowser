'use strict';
// electron-builder `afterPack`: VMP signing on macOS. See vmp-sign.js.
const { vmpSign } = require('./vmp-sign');
module.exports = async (context) => vmpSign('afterPack', context);
