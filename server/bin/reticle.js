#!/usr/bin/env node
/*
 * The `reticle` command. This file is CommonJS (see package.json in this folder) and uses only old
 * syntax, so that any Node.js can parse it. A Node.js older than the `engines` floor cannot load the
 * CLI's ES modules, so this file checks the version before any of them loads. launch.js loads them.
 */
'use strict';

/** A version such as `18.0.0` in place of this Node.js version. For tests only. */
var NODE_VERSION_ENV = 'RETICLE_TEST_NODE_VERSION';
var NODE_DOWNLOAD_URL = 'https://nodejs.org';
/** Only a plain floor (`>=20.11`) is read, as in src/command/cli/first-use-checks.ts. */
var NODE_FLOOR = /^>=\s*(\d+(?:\.\d+)*)$/;

/** The numbers of a version, or undefined. The same rule as `compareVersions`. */
function versionParts(version) {
  var nums = version
    .split('-')[0]
    .split('.')
    .map(function (n) {
      return parseInt(n, 10);
    });
  return nums.some(isNaN) ? undefined : nums;
}

/** The line for a Node.js older than `range`, or undefined. The same line as `nodeTooOldLine`. */
function nodeTooOldLine(version, range) {
  var match = typeof range === 'string' ? NODE_FLOOR.exec(range.trim()) : null;
  if (match === null) {
    return undefined;
  }
  var floor = match[1];
  var have = versionParts(version);
  var need = versionParts(floor);
  if (have === undefined || need === undefined) {
    return undefined;
  }
  for (var i = 0; i < Math.max(have.length, need.length); i += 1) {
    var diff = (have[i] || 0) - (need[i] || 0);
    if (diff > 0) {
      return undefined;
    }
    if (diff < 0) {
      return (
        'Reticle needs Node.js ' +
        floor +
        ' or later, and this is Node.js ' +
        version +
        '. Install the current Node.js LTS from ' +
        NODE_DOWNLOAD_URL +
        ', then run the command again.'
      );
    }
  }
  return undefined;
}

module.exports = { NODE_VERSION_ENV: NODE_VERSION_ENV, nodeTooOldLine: nodeTooOldLine };

if (require.main === module) {
  var engines = require('../package.json').engines || {};
  var line = nodeTooOldLine(process.env[NODE_VERSION_ENV] || process.versions.node, engines.node);
  if (line !== undefined) {
    process.stderr.write(line + '\n');
    process.exit(1);
  }
  require('./launch.js');
}
