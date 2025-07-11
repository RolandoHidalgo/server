/*
 * (c) Copyright Ascensio System SIA 2010-2024
 *
 * This program is a free software product. You can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License (AGPL)
 * version 3 as published by the Free Software Foundation. In accordance with
 * Section 7(a) of the GNU AGPL its Section 15 shall be amended to the effect
 * that Ascensio System SIA expressly excludes the warranty of non-infringement
 * of any third-party rights.
 *
 * This program is distributed WITHOUT ANY WARRANTY; without even the implied
 * warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR  PURPOSE. For
 * details, see the GNU AGPL at: http://www.gnu.org/licenses/agpl-3.0.html
 *
 * You can contact Ascensio System SIA at 20A-6 Ernesta Birznieka-Upish
 * street, Riga, Latvia, EU, LV-1050.
 *
 * The  interactive user interfaces in modified source and object code versions
 * of the Program must display Appropriate Legal Notices, as required under
 * Section 5 of the GNU AGPL version 3.
 *
 * Pursuant to Section 7(b) of the License you must retain the original Product
 * logo when distributing the program. Pursuant to Section 7(e) we decline to
 * grant you any rights under trademark law for use of our trademarks.
 *
 * All the Product's GUI elements, including illustrations and icon sets, as
 * well as technical writing content are licensed under the terms of the
 * Creative Commons Attribution-ShareAlike 4.0 International. See the License
 * terms at http://creativecommons.org/licenses/by-sa/4.0/legalcode
 *
 */

'use strict';

var pg = require('pg');
var co = require('co');
var types = require('pg').types;
const connectorUtilities = require('./connectorUtilities');
const operationContext = require('../../../Common/sources/operationContext');
const config = require('config');
var configSql = config.get('services.CoAuthoring.sql');
const cfgTableResult = config.get('services.CoAuthoring.sql.tableResult');
var pgPoolExtraOptions = config.util.cloneDeep(configSql.get('pgPoolExtraOptions'));
const cfgEditor = config.get('services.CoAuthoring.editor');

let connectionConfig = {
  host: configSql.get('dbHost'),
  port: parseInt(configSql.get('dbPort')),
  user: configSql.get('dbUser'),
  password: configSql.get('dbPass'),
  database: configSql.get('dbName'),
  max: configSql.get('connectionlimit'),
  min: 0,
  ssl: false
};
//clone pgPoolExtraOptions to resolve 'TypeError: Cannot redefine property: key' in pg-pool
//timeouts from https://github.com/brianc/node-postgres/issues/3018#issuecomment-1619729794
config.util.extendDeep(connectionConfig, pgPoolExtraOptions);
var pool = new pg.Pool(connectionConfig);
//listen "error" event otherwise - unhandled exception(https://github.com/brianc/node-postgres/issues/2764#issuecomment-1163475426)
pool.on('error', (err, client) => {
  operationContext.global.logger.error(`postgresql pool error %s`, err.stack)
})
//todo datetime timezone
pg.defaults.parseInputDatesAsUTC = true;
types.setTypeParser(1114, function(stringValue) {
  return new Date(stringValue + '+0000');
});
types.setTypeParser(1184, function(stringValue) {
  return new Date(stringValue + '+0000');
});

var maxPacketSize = configSql.get('max_allowed_packet');

function sqlQuery(ctx, sqlCommand, callbackFunction, opt_noModifyRes, opt_noLog, opt_values) {
  co(function *() {
    var result = null;
    var error = null;
    try {
      result = yield pool.query(sqlCommand, opt_values);
    } catch (err) {
      error = err;
      if (!opt_noLog) {
        ctx.logger.warn('sqlQuery error sqlCommand: %s: %s', sqlCommand.slice(0, 50), err.stack);
      }
    } finally {
      if (callbackFunction) {
        var output = result;
        if (result && !opt_noModifyRes) {
          if ('SELECT' === result.command) {
            output = result.rows;
          } else {
            output = {affectedRows: result.rowCount};
          }
        }
        callbackFunction(error, output);
      }
    }
  });
}

function closePool() {
  pool.end();
}

function addSqlParameter(val, values) {
  values.push(val);
  return '$' + values.length;
}

function concatParams(val1, val2) {
  return `COALESCE(${val1}, '') || COALESCE(${val2}, '')`;
}

var isSupportOnConflict = true;

function getUpsertString(task, values) {
  task.completeDefaults();
  let dateNow = new Date();
  let cbInsert = task.callback;
  if (isSupportOnConflict && task.callback) {
    let userCallback = new connectorUtilities.UserCallback();
    userCallback.fromValues(task.userIndex, task.callback);
    cbInsert = userCallback.toSQLInsert();
  }
  let p0 = addSqlParameter(task.tenant, values);
  let p1 = addSqlParameter(task.key, values);
  let p2 = addSqlParameter(task.status, values);
  let p3 = addSqlParameter(task.statusInfo, values);
  let p4 = addSqlParameter(dateNow, values);
  let p5 = addSqlParameter(task.userIndex, values);
  let p6 = addSqlParameter(task.changeId, values);
  let p7 = addSqlParameter(cbInsert, values);
  let p8 = addSqlParameter(task.baseurl, values);
  if (isSupportOnConflict) {
    let p9 = addSqlParameter(dateNow, values);
    //http://stackoverflow.com/questions/34762732/how-to-find-out-if-an-upsert-was-an-update-with-postgresql-9-5-upsert
    let sqlCommand = `INSERT INTO ${cfgTableResult} (tenant, id, status, status_info, last_open_date, user_index, change_id, callback, baseurl)`;
    sqlCommand += ` VALUES (${p0}, ${p1}, ${p2}, ${p3}, ${p4}, ${p5}, ${p6}, ${p7}, ${p8})`;
    sqlCommand += ` ON CONFLICT (tenant, id) DO UPDATE SET last_open_date = ${p9}`;
    if (task.callback) {
      let p10 = addSqlParameter(JSON.stringify(task.callback), values);
      sqlCommand += `, callback = ${cfgTableResult}.callback || '${connectorUtilities.UserCallback.prototype.delimiter}{"userIndex":' `;
      sqlCommand += ` || (${cfgTableResult}.user_index + 1)::text || ',"callback":' || ${p10}::text || '}'`;
    }
    if (task.baseurl) {
      let p11 = addSqlParameter(task.baseurl, values);
      sqlCommand += `, baseurl = ${p11}`;
    }
    sqlCommand += `, user_index = ${cfgTableResult}.user_index + 1 RETURNING user_index as userindex;`;
    return sqlCommand;
  } else {
    return `SELECT * FROM merge_db(${p0}, ${p1}, ${p2}, ${p3}, ${p4}, ${p5}, ${p6}, ${p7}, ${p8});`;
  }
}

function upsert(ctx, task) {
  return new Promise(function(resolve, reject) {
    let values = [];
    var sqlCommand = getUpsertString(task, values);
    sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        if (isSupportOnConflict && '42601' === error.code) {
          //SYNTAX ERROR
          isSupportOnConflict = false;
          ctx.logger.warn('checkIsSupportOnConflict false');
          resolve(upsert(ctx, task));
        } else {
          reject(error);
        }
      } else {
        if (result && result.rows.length > 0) {
          var first = result.rows[0];
          result = {};
          result.isInsert = task.userIndex === first.userindex;
          result.insertId = first.userindex;
        }
        resolve(result);
      }
    }, true, undefined, values);
  });
}

function insertChanges(ctx, tableChanges, startIndex, objChanges, docId, index, user, callback) {
  let i = startIndex;
  if (i >= objChanges.length) {
    return;
  }
  let isSupported = true;
  let tenant = [];
  let id = [];
  let changeId = [];
  let userId = [];
  let userIdOriginal = [];
  let username = [];
  let change = [];
  let time = [];
  //Postgres 9.4 multi-argument unnest
  let sqlCommand = `INSERT INTO ${tableChanges} (tenant, id, change_id, user_id, user_id_original, user_name, change_data, change_date) `;
  let changesType = cfgEditor['binaryChanges'] ? 'bytea' : 'text';
  sqlCommand += `SELECT * FROM UNNEST ($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::${changesType}[], $8::timestamp[]);`;
  let values = [tenant, id, changeId, userId, userIdOriginal, username, change, time];
  let curLength = sqlCommand.length;
  for (; i < objChanges.length; ++i) {
    //4 is max utf8 bytes per symbol
    curLength += 4 * (docId.length + user.id.length + user.idOriginal.length + user.username.length + objChanges[i].change.length) + 4 + 8;
    if (curLength >= maxPacketSize && i > startIndex) {
      sqlQuery(ctx, sqlCommand, function(error, output) {
        if (error && '42883' == error.code) {
          isSupported = false;
          ctx.logger.warn('postgresql does not support UNNEST');
        }
        if (error) {
          callback(error, output, isSupported);
        } else {
          insertChanges(ctx, tableChanges, i, objChanges, docId, index, user, callback);
        }
      }, undefined, undefined, values);
      return;
    }
    tenant.push(ctx.tenant);
    id.push(docId);
    changeId.push(index++);
    userId.push(user.id);
    userIdOriginal.push(user.idOriginal);
    username.push(user.username);
    change.push(objChanges[i].change);
    time.push(objChanges[i].time);
  }
  sqlQuery(ctx, sqlCommand, function(error, output) {
    if (error && '42883' == error.code) {
      isSupported = false;
      ctx.logger.warn('postgresql does not support UNNEST');
    }
    callback(error, output, isSupported);
  }, undefined, undefined, values);
}

module.exports = {
  sqlQuery,
  closePool,
  addSqlParameter,
  concatParams,
  upsert,
  insertChanges
};