'use strict';

const path = require('path');

const configured = String(process.env.CREW_FORGE_DATA_DIR || '').trim();

module.exports = configured ? path.resolve(configured) : path.join(__dirname, '..', 'data');
