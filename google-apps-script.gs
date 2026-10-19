/**
 * UPI -> Splitwise Google Apps Script
 *
 * Authentication:
 *   cookie: complete browser Cookie header value
 *   csrf_token: X-CSRF-Token request header value
 */

const CONFIG = {
  CURRENCY_CODE: "INR",
  DEBUG: false,
  BASE_URL: "https://secure.splitwise.com/api/v3.0"
};


// ==================================================
// 1. GET: Fetch groups or members
// ==================================================

function doGet(e) {
  try {
    const requestData = (e && e.parameter) || {};

    validateRequestSecret(requestData);

    const cookie = getSessionCookie(requestData);

    if (requestData.group_name) {
      const group = findGroupByName(
        requestData.group_name,
        cookie
      );

      return jsonOutput({
        members: group.members.map(fullName).filter(Boolean)
      });
    }

    const groups = getGroups(cookie)
      .filter(g =>
        Number(g.id) !== 0 &&
        Array.isArray(g.members) &&
        g.members.length > 0
      )
      .map(g => g.name);

    return jsonOutput({ groups: groups });

  } catch (error) {
    return jsonOutput({
      error: error.message || String(error)
    });
  }
}


// ==================================================
// 2. POST: Create expense
// ==================================================

function doPost(e) {
  try {
    const requestData = JSON.parse(
      (e && e.postData && e.postData.contents) || "{}"
    );

    validateRequestSecret(requestData);

    // Preserve the existing Shortcut parameter names.
    const expenseParams = {
      cookie:
        requestData.cookie ||
        requestData.session_cookie ||
        requestData.Cookie ||
        null,

      // Backward compatibility: api_key is accepted only
      // if it contains a browser cookie string.
      api_key:
        requestData.api_key ||
        requestData.API_KEY ||
        null,

      csrf_token:
        requestData.csrf_token ||
        requestData.csrfToken ||
        requestData["X-CSRF-Token"] ||
        requestData.x_csrf_token ||
        null,

      group_name:
        requestData.Group || requestData.group_name,

      amount:
        requestData.Amount !== undefined
          ? requestData.Amount
          : requestData.amount,

      description:
        requestData.Description || requestData.description,

      split_method:
        requestData["Split Method"] ||
        requestData.split_method ||
        "equal",

      selected_people: requestData.selected_people,

      user_splits: requestData.user_splits,

      currency_code:
        requestData.currency_code || CONFIG.CURRENCY_CODE
    };

    const result = createSplitwiseExpense(expenseParams);

    return jsonOutput(result);

  } catch (error) {
    if (CONFIG.DEBUG) {
      console.error(error.stack || error);
    }

    return jsonOutput({
      success: false,
      error: error.message || String(error)
    });
  }
}


// ==================================================
// 3. Resolve the session cookie
// ==================================================

function getSessionCookie(params) {
  let cookie = null;

  if (typeof params === "string") {
    cookie = params;

  } else if (params && typeof params === "object") {
    cookie =
      params.cookie ||
      params.session_cookie ||
      params.Cookie ||
      null;

    // The legacy api_key field can contain a cookie,
    // but an old Bearer API key is not a browser cookie.
    if (!cookie) {
      const legacyValue =
        params.api_key || params.API_KEY || null;

      if (
        typeof legacyValue === "string" &&
        (
          /(?:^|;\s*)user_credentials=/.test(legacyValue) ||
          (
            /(?:^|;\s*)swdid=/.test(legacyValue) &&
            /(?:^|;\s*)_splitwise_session=/.test(legacyValue)
          )
        )
      ) {
        cookie = legacyValue;
      }
    }
  }

  // Optional fallback to Script Properties.
  if (!cookie) {
    cookie = PropertiesService.getScriptProperties()
      .getProperty("SPLITWISE_COOKIE");
  }

  if (!cookie) {
    throw new Error(
      "Session cookie is missing. Pass params.cookie or configure SPLITWISE_COOKIE."
    );
  }

  cookie = String(cookie).trim();

  const hasUserCredentials =
    /(?:^|;\s*)user_credentials=/.test(cookie);

  const hasSwdid =
    /(?:^|;\s*)swdid=/.test(cookie);

  const hasSplitwiseSession =
    /(?:^|;\s*)_splitwise_session=/.test(cookie);

  return cookie;
}


// ==================================================
// 4. Resolve the CSRF token
// ==================================================

function getCsrfToken(params) {
  let token = null;

  if (params && typeof params === "object") {
    token =
      params.csrf_token ||
      params.csrfToken ||
      params["X-CSRF-Token"] ||
      params.x_csrf_token ||
      null;
  }

  // Optional fallback to Script Properties.
  if (!token) {
    token = PropertiesService.getScriptProperties()
      .getProperty("SPLITWISE_CSRF_TOKEN");
  }

  if (!token) {
    throw new Error(
      "CSRF token is missing. Pass csrf_token or configure SPLITWISE_CSRF_TOKEN."
    );
  }

  return String(token).trim();
}


// ==================================================
// 5. Optional request-secret validation
// ==================================================

function validateRequestSecret(params) {
  const expected = PropertiesService.getScriptProperties()
    .getProperty("REQUEST_SECRET");

  // Validation is disabled if REQUEST_SECRET is not configured.
  if (!expected) {
    return;
  }

  if (!params || params.request_secret !== expected) {
    throw new Error("Unauthorized request.");
  }
}


// ==================================================
// 6. Create a Splitwise expense
// ==================================================

function createSplitwiseExpense(params) {
  if (
    params.amount === undefined ||
    params.amount === null ||
    String(params.amount).trim() === "" ||
    !params.description ||
    !params.group_name
  ) {
    throw new Error(
      "Missing required fields: amount, description, or group_name."
    );
  }

  const amount = Number(params.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive number.");
  }

  const cookie = getSessionCookie(params);

  // Identify the authenticated user.
  const currentUser = getCurrentUser(cookie);
  const currentUserId = String(currentUser.id);

  // Find the destination group.
  const group = findGroupByName(
    params.group_name,
    cookie
  );

  const splitMethod = String(
    params.split_method || "equal"
  ).toLowerCase();

  const expenseData = {
    cost: amount.toFixed(2),
    description: String(params.description).trim(),
    currency_code:
      params.currency_code || CONFIG.CURRENCY_CODE,
    group_id: String(group.id)
  };


  // ------------------------------------------------
  // A. Equal split among the entire group
  // ------------------------------------------------

  if (
    splitMethod === "equal" ||
    splitMethod === "equal split"
  ) {
    expenseData.split_equally = true;
  }


  // ------------------------------------------------
  // B. Equal split among selected people
  // ------------------------------------------------

  else if (splitMethod === "split_selected_equally") {
    const selectedNames = processSelectedPeople(
      params.selected_people
    );

    if (!selectedNames.length) {
      throw new Error("No people selected for split.");
    }

    const selectedUsers = [];
    const seen = {};

    selectedNames.forEach(name => {
      const needle = name.toLowerCase().trim();

      const matches = group.members.filter(user => {
        const full = fullName(user).toLowerCase();
        const first = String(
          user.first_name || ""
        ).toLowerCase();

        return full === needle || first === needle;
      });

      if (matches.length > 1) {
        throw new Error(
          '"' + name +
          '" matches multiple members. Use full names.'
        );
      }

      if (!matches.length) {
        throw new Error(
          'Could not find "' + name +
          '" in group "' + group.name + '".'
        );
      }

      const user = matches[0];
      const userId = String(user.id);

      // Prevent duplicate users.
      if (!seen[userId]) {
        seen[userId] = true;
        selectedUsers.push(user);
      }
    });

    if (!selectedUsers.length) {
      throw new Error("No valid people selected for split.");
    }

    // Integer paise avoid floating-point rounding errors.
    const totalPaise = Math.round(amount * 100);

    const basePaise = Math.floor(
      totalPaise / selectedUsers.length
    );

    let remainder =
      totalPaise - basePaise * selectedUsers.length;

    const payerIncluded = selectedUsers.some(
      user => String(user.id) === currentUserId
    );

    let index = 0;

    selectedUsers.forEach(user => {
      let sharePaise = basePaise;

      // Distribute remaining paise one at a time.
      if (remainder > 0) {
        sharePaise++;
        remainder--;
      }

      expenseData[
        "users__" + index + "__user_id"
      ] = String(user.id);

      expenseData[
        "users__" + index + "__paid_share"
      ] =
        String(user.id) === currentUserId
          ? amount.toFixed(2)
          : "0.00";

      expenseData[
        "users__" + index + "__owed_share"
      ] = (sharePaise / 100).toFixed(2);

      index++;
    });

    // If the payer isn't selected, add them as the payer
    // with a zero owed share.
    if (!payerIncluded) {
      expenseData[
        "users__" + index + "__user_id"
      ] = currentUserId;

      expenseData[
        "users__" + index + "__paid_share"
      ] = amount.toFixed(2);

      expenseData[
        "users__" + index + "__owed_share"
      ] = "0.00";
    }
  }


  // ------------------------------------------------
  // C. Custom split
  // ------------------------------------------------

  else if (splitMethod === "custom") {
    const splits = parseCustomSplits(params.user_splits);

    if (!splits.length) {
      throw new Error(
        'Custom split requires a non-empty "user_splits" array.'
      );
    }

    const memberIds = {};

    group.members.forEach(user => {
      memberIds[String(user.id)] = true;
    });

    const seen = {};
    let totalPaid = 0;
    let totalOwed = 0;

    splits.forEach((split, index) => {
      const userId = String(split.user_id);

      if (!memberIds[userId]) {
        throw new Error(
          "User " + userId +
          " is not a member of group " + group.name + "."
        );
      }

      if (seen[userId]) {
        throw new Error(
          "Duplicate user ID in custom split: " + userId
        );
      }

      seen[userId] = true;

      const paidPaise = amountToPaise(
        split.paid_share,
        "paid_share"
      );

      const owedPaise = amountToPaise(
        split.owed_share,
        "owed_share"
      );

      if (paidPaise < 0 || owedPaise < 0) {
        throw new Error(
          "Custom split shares cannot be negative."
        );
      }

      totalPaid += paidPaise;
      totalOwed += owedPaise;

      expenseData[
        "users__" + index + "__user_id"
      ] = userId;

      expenseData[
        "users__" + index + "__paid_share"
      ] = (paidPaise / 100).toFixed(2);

      expenseData[
        "users__" + index + "__owed_share"
      ] = (owedPaise / 100).toFixed(2);
    });

    const totalPaise = Math.round(amount * 100);

    if (totalPaid !== totalPaise) {
      throw new Error(
        "Custom paid shares must total the expense amount."
      );
    }

    if (totalOwed !== totalPaise) {
      throw new Error(
        "Custom owed shares must total the expense amount."
      );
    }
  }


  // ------------------------------------------------
  // Unsupported split method
  // ------------------------------------------------

  else {
    throw new Error(
      'Unsupported split method "' +
      params.split_method +
      '". Use equal, split_selected_equally, or custom.'
    );
  }


  // ------------------------------------------------
  // Create the expense, including the CSRF token
  // ------------------------------------------------

  const csrfToken = getCsrfToken(params);

  const response = makeAuthenticatedRequest(
    "POST",
    CONFIG.BASE_URL + "/create_expense",
    expenseData,
    cookie,
    csrfToken
  );

  if (hasApiErrors(response.errors)) {
    throw new Error(
      "Splitwise rejected the expense: " +
      formatErrors(response.errors)
    );
  }

  const created =
    response.expenses && response.expenses[0];

  if (!created || created.deleted_at) {
    throw new Error(
      "Splitwise did not confirm expense creation."
    );
  }

  return {
    success: true,
    summary:
      "Created: " +
      params.description +
      " (" +
      amount.toFixed(2) +
      " " +
      (params.currency_code || CONFIG.CURRENCY_CODE) +
      ") in " +
      group.name,
    expense_id: created.id || null
  };
}


// ==================================================
// 7. Authenticated API request
// ==================================================

function makeAuthenticatedRequest(
  method,
  url,
  data,
  cookie,
  csrfToken
) {
  cookie = getSessionCookie(cookie);

  const headers = {
    Cookie: cookie,
    Accept: "application/json, text/javascript, */*; q=0.01",
    Origin: "https://secure.splitwise.com",
    Referer: "https://secure.splitwise.com/",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/150.0.0.0 Safari/537.36"
  };

  // The browser's CSRF header is sent when supplied.
  if (csrfToken) {
    headers["X-CSRF-Token"] = csrfToken;
  }

  const options = {
    method: method.toLowerCase(),
    headers: headers,
    muteHttpExceptions: true,
    followRedirects: false
  };

  if (data) {
    // Match the browser request's form-encoded content type.
    options.contentType =
      "application/x-www-form-urlencoded";

    options.payload = Object.keys(data)
      .map(key =>
        encodeURIComponent(key) +
        "=" +
        encodeURIComponent(
          data[key] === null || data[key] === undefined
            ? ""
            : String(data[key])
        )
      )
      .join("&");
  }

  const response = UrlFetchApp.fetch(url, options);

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (CONFIG.DEBUG) {
    console.log(
      method + " " + url + " -> HTTP " + status
    );

    // Do not log cookies or CSRF tokens.
    console.log(body.substring(0, 1500));
  }

  if (status >= 300 && status < 400) {
    throw new Error(
      "Splitwise redirected the request. Refresh your session cookie."
    );
  }

  if (status < 200 || status >= 300) {
    throw new Error(
      "Splitwise request failed (HTTP " +
      status +
      "): " +
      body.substring(0, 500)
    );
  }

  let result;

  try {
    result = JSON.parse(body);
  } catch (error) {
    throw new Error(
      "Splitwise returned a non-JSON response. " +
      "Check the cookie and request format."
    );
  }

  return result;
}


// ==================================================
// 8. Get current user
// ==================================================

function getCurrentUser(cookie) {
  const response = makeAuthenticatedRequest(
    "GET",
    CONFIG.BASE_URL + "/get_current_user",
    null,
    cookie
  );

  if (!response.user || !response.user.id) {
    throw new Error(
      "Could not identify the current Splitwise user."
    );
  }

  return response.user;
}


// ==================================================
// 9. Get groups
// ==================================================

function getGroups(cookie) {
  const response = makeAuthenticatedRequest(
    "GET",
    CONFIG.BASE_URL + "/get_groups",
    null,
    cookie
  );

  if (!Array.isArray(response.groups)) {
    throw new Error(
      "Unexpected response while fetching groups."
    );
  }

  return response.groups;
}


// ==================================================
// 10. Find group by name
// ==================================================

function findGroupByName(groupName, cookie) {
  const groups = getGroups(cookie);

  const cleaned = String(groupName)
    .replace(/\s+/g, "")
    .toLowerCase();

  // Exact match first.
  let target = groups.find(group =>
    String(group.name)
      .replace(/\s+/g, "")
      .toLowerCase() === cleaned
  );

  // Then allow a unique partial match.
  if (!target) {
    const matches = groups.filter(group =>
      String(group.name)
        .replace(/\s+/g, "")
        .toLowerCase()
        .includes(cleaned)
    );

    if (matches.length > 1) {
      throw new Error(
        'Group "' + groupName +
        '" is ambiguous. Use the exact group name.'
      );
    }

    target = matches[0];
  }

  if (!target) {
    throw new Error(
      'Group "' + groupName + '" not found.'
    );
  }

  return target;
}


// ==================================================
// 11. Parse selected people
// ==================================================

function processSelectedPeople(input) {
  if (!input) {
    return [];
  }

  if (Array.isArray(input)) {
    return input
      .map(value => String(value).trim())
      .filter(Boolean);
  }

  if (typeof input === "string") {
    return input
      .split(/[\n,]+/)
      .map(value => value.trim())
      .filter(Boolean);
  }

  return [];
}


// ==================================================
// 12. Parse custom splits
// ==================================================

function parseCustomSplits(input) {
  if (!input) {
    return [];
  }

  let values = input;

  if (typeof values === "string") {
    try {
      values = JSON.parse(values);
    } catch (error) {
      throw new Error(
        "user_splits must be an array or a JSON array string."
      );
    }
  }

  if (!Array.isArray(values)) {
    throw new Error("user_splits must be an array.");
  }

  return values.map(value => {
    let split = value;

    // Supports the original tests' JSON-string entries.
    if (typeof split === "string") {
      try {
        split = JSON.parse(split);
      } catch (error) {
        throw new Error(
          "Each user_splits entry must be valid JSON."
        );
      }
    }

    if (
      !split ||
      split.user_id === undefined ||
      split.paid_share === undefined ||
      split.owed_share === undefined
    ) {
      throw new Error(
        "Each split requires user_id, paid_share, and owed_share."
      );
    }

    return split;
  });
}


// ==================================================
// 13. Utility functions
// ==================================================

function amountToPaise(value, fieldName) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(
      fieldName + " must be a valid amount."
    );
  }

  return Math.round(number * 100);
}


function fullName(user) {
  return [
    user.first_name,
    user.last_name
  ].filter(Boolean).join(" ").trim();
}


function hasApiErrors(errors) {
  if (!errors) {
    return false;
  }

  if (Array.isArray(errors)) {
    return errors.length > 0;
  }

  if (typeof errors === "string") {
    return errors.trim().length > 0;
  }

  if (typeof errors === "object") {
    return Object.keys(errors).some(key => {
      const value = errors[key];

      if (Array.isArray(value)) {
        return value.length > 0;
      }

      if (value && typeof value === "object") {
        return Object.keys(value).length > 0;
      }

      return value !== null &&
        value !== undefined &&
        String(value).trim() !== "";
    });
  }

  return Boolean(errors);
}


function formatErrors(errors) {
  if (Array.isArray(errors)) {
    return errors.join(", ");
  }

  if (typeof errors === "string") {
    return errors;
  }

  if (!errors || typeof errors !== "object") {
    return String(errors);
  }

  return Object.keys(errors)
    .map(key => {
      const value = errors[key];

      return key + ": " +
        (
          Array.isArray(value)
            ? value.join(", ")
            : String(value)
        );
    })
    .join("; ");
}


function jsonOutput(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}


// ==================================================
// 14. Test: Create expense
// ==================================================

function testCreateExpense() {
  const testParams = {
    cookie:
      "user_credentials=<YOUR_USER_CREDENTIALS>; " +
      "swdid=<YOUR_SWDID>; " +
      "_splitwise_session=<YOUR_SESSION_COOKIE>",

    csrf_token: "<YOUR_CSRF_TOKEN>",

    group_name: "Test Group",
    amount: "100.00",
    description: "Test Expense",
    split_method: "equal",
    currency_code: "INR"
  };

  // Creates a real expense.
  const result = createSplitwiseExpense(testParams);

  console.log(
    "Test Result:",
    JSON.stringify(result, null, 2)
  );

  return result;
}


// ==================================================
// 15. Test: Selected equal split
// ==================================================

function testSplitSelectedEqually() {
  const testParams = {
    cookie:
      "_splitwise_session=<YOUR_SESSION_COOKIE>",
    csrf_token: "<YOUR_CSRF_TOKEN>",
    group_name: "SW Group Testing",
    amount: "3",
    description: "Test Split Selected Equally",
    split_method: "split_selected_equally",

    selected_people:
      "Kamal Sharma\nRitik Kumar\nPratham Arora",

    currency_code: "INR"
  };

  // Creates a real expense.
  const result = createSplitwiseExpense(testParams);

  console.log(
    "Split Selected Test Result:",
    JSON.stringify(result, null, 2)
  );

  return result;
}


// ==================================================
// 16. Test: Custom split
// ==================================================

function testCustomSplit() {
  const testParams = {
    cookie:
      "_splitwise_session=<YOUR_SESSION_COOKIE>",

    csrf_token: "<YOUR_CSRF_TOKEN>",

    group_name: "Test Group",
    amount: "150.00",
    description: "Test Custom Split",
    split_method: "custom",

    user_splits: [
      '{"user_id":"123456","paid_share":"150.00","owed_share":"75.00"}',
      '{"user_id":"789012","paid_share":"0.00","owed_share":"75.00"}'
    ],

    currency_code: "INR"
  };

  // Replace sample IDs with actual group-member IDs.
  // Creates a real expense.
  const result = createSplitwiseExpense(testParams);

  console.log(
    "Custom Split Test Result:",
    JSON.stringify(result, null, 2)
  );

  return result;
}


// ==================================================
// 17. Test: Connection only (no expense creation)
// ==================================================

function testSplitwiseConnection() {
  const params = {
    cookie:
      "_splitwise_session=<YOUR_SESSION_COOKIE>"
  };

  const cookie = getSessionCookie(params);

  const user = getCurrentUser(cookie);
  const groups = getGroups(cookie);

  const result = {
    authenticated: true,
    user: fullName(user),
    group_count: groups.length
  };

  console.log(JSON.stringify(result, null, 2));

  return result;
}
