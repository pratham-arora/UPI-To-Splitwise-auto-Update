/**
 * Google Apps Script for Splitwise iOS Shortcut
 * HANDLES BOTH: Creating expenses (POST) and Fetching groups/members (GET)
 */

const CONFIG = {
  API_KEY: "mvWPNZ4VK1F4bV5H8SHkFZadZlsDYIwjIWZpLjvv", // Keep your API Key here
  CURRENCY_CODE: "INR",
  DEBUG: false
};

// ==========================================
// 1. NEW: doGet Function (For fetching data)
// ==========================================
function doGet(e) {
  try {
    // SCENARIO A: Fetch members for a specific group (e.g., ?group_name=Goa)
    if (e.parameter.group_name) {
      const groupName = e.parameter.group_name;
      const group = findGroupByName(groupName); 
      
      // Format members for the Shortcut list
      const members = group.members.map(u => {
        return u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name;
      });

      return ContentService
        .createTextOutput(JSON.stringify({ members: members }))
        .setMimeType(ContentService.MimeType.JSON);
    } 
    
    // SCENARIO B: Fetch all available groups (Default when no params)
    else {
      const groupsUrl = "https://secure.splitwise.com/api/v3.0/get_groups";
      const response = makeAuthenticatedRequest('GET', groupsUrl);
      
      // Filter out empty groups and just get names
      const activeGroups = response.groups
        .filter(g => g.id !== 0 && g.members.length > 0)
        .map(g => g.name);

      return ContentService
        .createTextOutput(JSON.stringify({ groups: activeGroups }))
        .setMimeType(ContentService.MimeType.JSON);
    }

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 2. EXISTING: doPost Function (For creating expenses)
// ==========================================
function doPost(e) {
  try {
    const requestData = JSON.parse(e.postData.contents);
    
    if (CONFIG.DEBUG) console.log('Received request:', JSON.stringify(requestData));
    
    // Clean extraction for generic Shortcut
    const expenseParams = {
      group_name: requestData.Group || requestData.group_name,
      amount: requestData.Amount || requestData.amount,
      description: requestData.Description || requestData.description,
      split_method: requestData['Split Method'] || requestData.split_method || 'equal',
      selected_people: requestData.selected_people,
      currency_code: CONFIG.CURRENCY_CODE,
      debug: CONFIG.DEBUG
    };
    
    const result = createSplitwiseExpense(expenseParams);
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    console.error('Error in doPost:', error);
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// 3. Helper Functions (Logic)
// ==========================================

function createSplitwiseExpense(params) {
  if (!params.amount || !params.description || !params.group_name) {
    throw new Error("Missing required fields: amount, description, or group_name");
  }

  // 1. Get Current User ID
  const currentUser = getCurrentUser(params.debug);
  const currentUserId = currentUser.id;

  // 2. Find Group
  const group = findGroupByName(params.group_name, params.debug);
  const groupId = group.id;

  // 3. Prepare Base Expense
  const expenseData = {
    cost: params.amount,
    description: params.description,
    currency_code: params.currency_code,
    group_id: parseInt(groupId),
  };

  // 4. Handle Splits
  if (params.split_method === "equal" || params.split_method === "equal split") {
    expenseData.split_equally = true;
  }
  else if (params.split_method === "split_selected_equally") {
    // Handle specific people
    let selectedNames = processSelectedPeople(params.selected_people);
    
    if (!selectedNames || selectedNames.length === 0) {
      throw new Error("No people selected for split.");
    }

    // Match names to IDs
    const selectedUsers = [];
    // Always include yourself if not explicitly selected? 
    // Usually "Split Selected" implies you + them. 
    // IMPORTANT: Make sure YOU are in the selected list from shortcut or added here.
    // For now, we assume the list passed from Shortcut includes everyone involved.
    
    for (const name of selectedNames) {
      const user = group.members.find(u => {
        const fullName = u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name;
        // Fuzzy match first name or full name
        return fullName.toLowerCase().includes(name.toLowerCase()) || 
               u.first_name.toLowerCase() === name.toLowerCase();
      });
      if (user) selectedUsers.push(user);
    }

    // Add current user if not in list (Optional logic - usually safer to add self)
    if (!selectedUsers.find(u => u.id === currentUserId)) {
      selectedUsers.push({ id: currentUserId }); 
    }

    const share = (parseFloat(params.amount) / selectedUsers.length).toFixed(2);

    selectedUsers.forEach((user, index) => {
      expenseData[`users__${index}__user_id`] = user.id;
      expenseData[`users__${index}__paid_share`] = user.id === currentUserId ? params.amount : "0.00";
      expenseData[`users__${index}__owed_share`] = share;
    });
  }

  // 5. Send to Splitwise
  const expenseUrl = "https://secure.splitwise.com/api/v3.0/create_expense";
  const response = makeAuthenticatedRequest('POST', expenseUrl, expenseData, params.debug);

  if (response.errors && response.errors.length > 0) {
    throw new Error(response.errors.join(", "));
  }

  return {
    success: true,
    summary: `Created: ${params.description} (${params.amount}) in ${group.name}`
  };
}

function makeAuthenticatedRequest(method, url, data = null, debug = false) {
  const options = {
    method: method,
    headers: { 'Authorization': `Bearer ${CONFIG.API_KEY}`, 'Accept': 'application/json' }
  };
  if (data) {
    options.headers['Content-Type'] = 'application/json';
    options.payload = JSON.stringify(data);
  }
  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

function getCurrentUser(debug) {
  return makeAuthenticatedRequest('GET', "https://secure.splitwise.com/api/v3.0/get_current_user", null, debug).user;
}

function findGroupByName(groupName, debug) {
  const response = makeAuthenticatedRequest('GET', "https://secure.splitwise.com/api/v3.0/get_groups", null, debug);
  const cleanedInput = groupName.replace(/\s+/g, '').toLowerCase();
  
  let target = response.groups.find(g => g.name.replace(/\s+/g, '').toLowerCase() === cleanedInput);
  if (!target) {
    target = response.groups.find(g => g.name.replace(/\s+/g, '').toLowerCase().includes(cleanedInput));
  }
  
  if (!target) throw new Error(`Group "${groupName}" not found.`);
  return target;
}

function processSelectedPeople(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') return input.split(',').map(s => s.trim());
  return [];
}
