/* AccountExpress mail-only relay. Runs as the Google account owner, never on a customer PC.
 * No SMTP/app password is used. Deployment/authorization is an owner action; see README.md.
 * ContentService returns HTTP 200 even for logical failures: clients MUST inspect ok/code.
 */
function doPost(event) {
  var lock;
  try {
    var request = parseRequest_(event);
    if (!request) return reply_(false, 'invalid_request');
    var properties = PropertiesService.getScriptProperties();
    var config = configuration_(properties);
    if (!config) return reply_(false, 'not_configured');
    var installation = authorize_(request.token, config);
    if (!installation) return reply_(false, 'unauthorized');
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) { lock = null; return reply_(false, 'busy'); }

    var now = Date.now();
    var day = new Date(now).toISOString().slice(0, 10);
    var prefix = 'ae:' + day + ':';
    var installationKey = prefix + 'i:' + installation;
    var recipientKey = prefix + 'r:' + digest_(request.message.to.toLowerCase());
    var globalKey = prefix + 'global';
    var state = JSON.parse(properties.getProperty(installationKey) || '{"count":0,"last":0,"requests":[]}');
    if (!Number.isInteger(state.count) || state.count < 0 || state.count > 3 ||
        !Number.isFinite(state.last) || state.last < 0 || !Array.isArray(state.requests) || state.requests.length !== state.count) return reply_(false, 'not_configured');
    var fingerprint = digest_(JSON.stringify({ message: request.message, language: request.language }));
    var previous = state.requests.filter(function (entry) { return entry.id === request.requestId; })[0];
    if (previous) {
      if (previous.digest !== fingerprint) return reply_(false, 'request_conflict');
      return reply_(previous.result === 'accepted', previous.result);
    }
    if (state.count >= 3 || now - state.last < 60000) return reply_(false, 'rate_limited');
    var recipientCount = Number(properties.getProperty(recipientKey) || '0');
    var globalCount = Number(properties.getProperty(globalKey) || '0');
    if (!Number.isInteger(recipientCount) || recipientCount < 0 || !Number.isInteger(globalCount) || globalCount < 0) return reply_(false, 'not_configured');
    if (recipientCount >= 3) return reply_(false, 'rate_limited');
    if (globalCount >= config.dailyLimit || MailApp.getRemainingDailyQuota() < 1) return reply_(false, 'quota_exhausted');

    // Reservations happen under the script-wide lock BEFORE contacting the provider.
    // Failed/ambiguous sends conservatively consume the allowance, preventing retry abuse.
    var receipt = { id: request.requestId, digest: fingerprint, result: 'delivery_unknown' };
    state.count += 1;
    state.last = now;
    state.requests.push(receipt);
    var reservation = {};
    reservation[installationKey] = JSON.stringify(state);
    reservation[recipientKey] = String(recipientCount + 1);
    reservation[globalKey] = String(globalCount + 1);
    properties.setProperties(reservation);
    var message = render_(request);
    try {
      MailApp.sendEmail(message);
      receipt.result = 'accepted';
    } catch (_) {
      receipt.result = 'delivery_failed';
    }
    properties.setProperty(installationKey, JSON.stringify(state));
    // Remove only this service's previous-day counters, not operator configuration.
    // Cleanup failure cannot turn an accepted send into a request to send it again.
    try {
      Object.keys(properties.getProperties()).forEach(function (name) {
        if (/^ae:\d{4}-\d{2}-\d{2}:/.test(name) && name.indexOf(prefix) !== 0) properties.deleteProperty(name);
      });
    } catch (_) { /* No tokens, recipients or provider errors are logged. */ }
    return reply_(receipt.result === 'accepted', receipt.result);
  } catch (_) {
    return reply_(false, 'unavailable');
  } finally {
    if (lock) lock.releaseLock();
  }
}

function parseRequest_(event) {
  try {
    var text = event && event.postData && event.postData.contents;
    if (typeof text !== 'string' || text.length > 4096) return null;
    var request = JSON.parse(text);
    if (!keys_(request, ['version', 'token', 'requestId', 'language', 'message'])) return null;
    if (request.version !== 1 || typeof request.language !== 'string' || !/^(es|en)$/.test(request.language)) return null;
    if (typeof request.token !== 'string' || request.token.length > 2048) return null;
    if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(request.requestId)) return null;
    var message = request.message;
    if (!message || typeof message.to !== 'string' || message.to.length > 254) return null;
    // One literal address; no display names, header injection, CC/BCC or recipient lists.
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(message.to)) return null;
    if (message.type === 'verification') {
      if (!keys_(message, ['type', 'to', 'code']) || typeof message.code !== 'string' || !/^\d{6}$/.test(message.code)) return null;
    } else if (message.type === 'recovery') {
      if (!keys_(message, ['type', 'to', 'token']) || typeof message.token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(message.token)) return null;
    } else return null;
    return request;
  } catch (_) { return null; }
}

function keys_(value, allowed) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === allowed.length && allowed.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
}

function configuration_(properties) {
  var key = (properties.getProperty('RELAY_SIGNING_KEY') || '').trim();
  var dailyLimit = Number(properties.getProperty('GLOBAL_DAILY_LIMIT') || '80');
  var revoked = JSON.parse(properties.getProperty('REVOKED_INSTALLATIONS') || '[]');
  if (!/^[0-9a-f]{64}$/i.test(key) || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) return null;
  if (!Array.isArray(revoked) || !revoked.every(function (id) { return typeof id === 'string'; })) return null;
  return { key: key, dailyLimit: dailyLimit, revoked: revoked };
}

function authorize_(token, config) {
  try {
    var pieces = token.split('.');
    if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(pieces[0])) return null;
    var signature = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(pieces[0], config.key, Utilities.Charset.UTF_8)).replace(/=+$/, '');
    if (signature.length !== pieces[1].length) return null;
    var difference = 0;
    for (var i = 0; i < signature.length; i++) difference |= signature.charCodeAt(i) ^ pieces[1].charCodeAt(i);
    if (difference !== 0) return null;
    var claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pieces[0])).getDataAsString('UTF-8'));
    if (!keys_(claims, ['id', 'exp']) || typeof claims.id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(claims.id)) return null;
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000) || config.revoked.indexOf(claims.id) !== -1) return null;
    return claims.id;
  } catch (_) { return null; }
}

function digest_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)).replace(/=+$/, '');
}

function render_(request) {
  var verification = request.message.type === 'verification';
  var english = request.language === 'en';
  return {
    to: request.message.to,
    subject: verification
      ? (english ? 'AccountExpress — Registration confirmation' : 'AccountExpress — Confirmación de registro')
      : (english ? 'AccountExpress — Account recovery' : 'AccountExpress — Recuperación de cuenta'),
    body: verification
      ? (english ? 'Your AccountExpress verification code is: ' : 'Tu código de verificación de AccountExpress es: ') + request.message.code
      : (english ? 'Your AccountExpress recovery token is: ' : 'Tu token de recuperación de AccountExpress es: ') + request.message.token,
    name: 'AccountExpress'
  };
}

function reply_(ok, code) {
  return ContentService.createTextOutput(JSON.stringify({ ok: ok, code: code })).setMimeType(ContentService.MimeType.JSON);
}
