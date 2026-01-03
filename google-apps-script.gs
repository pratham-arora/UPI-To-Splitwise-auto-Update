/**
 * Google Apps Script for Splitwise iOS Shortcut
 * HANDLES BOTH: Creating expenses (POST) and Fetching groups/members (GET)
 */

const CONFIG = {
  CURRENCY_CODE: "INR",
  DEBUG: false
};

// Note: API_KEY is now passed by each user in their request

// ==========================================
// 1. NEW: doGet Function (For fetching data)
// ==========================================
function doGet(e) {
  try {
    // Validate API key is provided
    const apiKey = e.parameter.api_key;
    if (!apiKey) {
      return ContentService
        .createTextOutput(JSON.stringify({ error: "API key is required. Pass it as ?api_key=YOUR_KEY" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // SCENARIO A: Fetch members for a specific group (e.g., ?group_name=Goa&api_key=YOUR_KEY)
    if (e.parameter.group_name) {
      const groupName = e.parameter.group_name;
      const group = findGroupByName(groupName, false, apiKey); 
      
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
      const response = makeAuthenticatedRequest('GET', groupsUrl, null, false, apiKey);
      
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
    
    // Validate API key is provided
    const apiKey = requestData.api_key || requestData.API_KEY;
    if (!apiKey) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: "API key is required in request body" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    if (CONFIG.DEBUG) console.log('Received request:', JSON.stringify(requestData));
    
    // Clean extraction for generic Shortcut
    const expenseParams = {
      group_name: requestData.Group || requestData.group_name,
      amount: requestData.Amount || requestData.amount,
      description: requestData.Description || requestData.description,
      split_method: requestData['Split Method'] || requestData.split_method || 'equal',
      selected_people: requestData.selected_people,
      currency_code: CONFIG.CURRENCY_CODE,
      debug: CONFIG.DEBUG,
      api_key: apiKey
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
  
  if (!params.api_key) {
    throw new Error("API key is required");
  }

  // 1. Get Current User ID
  const currentUser = getCurrentUser(params.debug, params.api_key);
  const currentUserId = currentUser.id;

  // 2. Find Group
  const group = findGroupByName(params.group_name, params.debug, params.api_key);
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
    
    let selectedNames = processSelectedPeople(params.selected_people);
    
    if (!selectedNames || selectedNames.length === 0) {
      throw new Error("No people selected for split.");
    }

    // Match names to IDs
    const selectedUsers = [];
    
    for (const name of selectedNames) {
      const user = group.members.find(u => {
        const fullName = u.last_name ? `${u.first_name} ${u.last_name}` : u.first_name;
        // Fuzzy match first name or full name
        return fullName.toLowerCase().includes(name.toLowerCase()) || 
               u.first_name.toLowerCase() === name.toLowerCase();
      });
      if (user) selectedUsers.push(user);
    }
    
    // --- PENNY FIX LOGIC START ---
    
    const totalAmount = parseFloat(params.amount);
    const numUsers = selectedUsers.length;
    
    // Calculate the base share (rounded down to 2 decimals)
    // e.g. 1.00 / 3 = 0.3333... -> 0.33
    const baseShare = Math.floor((totalAmount / numUsers) * 100) / 100;
    
    // Calculate the total that is accounted for so far
    // e.g. 0.33 * 3 = 0.99
    const totalAccounted = baseShare * numUsers;
    
    // Calculate remainder pennies to distribute
    // e.g. 1.00 - 0.99 = 0.01 (1 penny needs to be added to someone)
    let remainder = Math.round((totalAmount - totalAccounted) * 100);

    const payerInList = selectedUsers.find(u => u.id === currentUserId);
    let userIndex = 0;
    
    selectedUsers.forEach(user => {
      // Determine this user's specific share
      let userOwed = baseShare;
      
      // If we still have remainder pennies, give one to this user
      if (remainder > 0) {
        userOwed = (baseShare + 0.01);
        remainder--;
      }
      
      expenseData[`users__${userIndex}__user_id`] = user.id;
      expenseData[`users__${userIndex}__paid_share`] = "0.00"; 
      expenseData[`users__${userIndex}__owed_share`] = userOwed.toFixed(2); // Ensure 2 decimal string
      userIndex++;
    });
    
    // --- PENNY FIX LOGIC END ---
    
    // Now handle the Payer (You)
    if (!payerInList) {
      // You Paid full amount, Owe 0.00
      expenseData[`users__${userIndex}__user_id`] = currentUserId;
      expenseData[`users__${userIndex}__paid_share`] = params.amount;
      expenseData[`users__${userIndex}__owed_share`] = "0.00";
    } else {
      // You are in list: Find your entry and update 'paid_share'
      for (let i = 0; i < userIndex; i++) {
        if (expenseData[`users__${i}__user_id`] === currentUserId) {
          expenseData[`users__${i}__paid_share`] = params.amount;
          break;
        }
      }
    }
  }

  // 5. Send to Splitwise
  const expenseUrl = "https://secure.splitwise.com/api/v3.0/create_expense";
  const response = makeAuthenticatedRequest('POST', expenseUrl, expenseData, params.debug, params.api_key);

  if (response.errors && response.errors.length > 0) {
    throw new Error(response.errors.join(", "));
  }

  return {
    success: true,
    summary: `Created: ${params.description} (${params.amount}) in ${group.name}`
  };
}

function makeAuthenticatedRequest(method, url, data = null, debug = false, apiKey = null) {
  if (!apiKey) {
    throw new Error("API key is required for authenticated requests");
  }
  
  const options = {
    method: method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
  };
  if (data) {
    options.headers['Content-Type'] = 'application/json';
    options.payload = JSON.stringify(data);
  }
  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

function getCurrentUser(debug, apiKey) {
  return makeAuthenticatedRequest('GET', "https://secure.splitwise.com/api/v3.0/get_current_user", null, debug, apiKey).user;
}

function findGroupByName(groupName, debug, apiKey) {
  const response = makeAuthenticatedRequest('GET', "https://secure.splitwise.com/api/v3.0/get_groups", null, debug, apiKey);
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
  
  // NEW: Split by comma OR newline (\n)
  if (typeof input === 'string') {
    return input.split(/[\n,]+/).map(s => s.trim()).filter(s => s !== "");
  }

  return [];
}
/**
 * Manual function for testing - call this directly from script editor
 */
function testCreateExpense() {
  const testParams = {
    group_name: "Test Group",
    amount: "100.00",
    description: "Test Expense",
    split_method: "equal",
    currency_code: "INR",
    debug: true
  };
  
  const result = createSplitwiseExpense(testParams);
  console.log('Test Result:', JSON.stringify(result, null, 2));
  return result;
}

/**
 * Helper function for manual testing with different split methods
 */
function testSplitSelectedEqually() {
  const testParams = {
    group_name: "Flatmates",
    amount: "1",
    description: "Test Split Selected Equally",
    split_method: "split_selected_equally",
    selected_people: "Kamal Sharma Pratham Arora", // Replace with actual names from your group
    currency_code: "INR",
    api_key:"vFIsDuVXuEN7vccqR2tlPz5VqYBV83W2F742eDOO",
    debug: true
  };
  
  const result = createSplitwiseExpense(testParams);
  console.log('Split Selected Test Result:', JSON.stringify(result, null, 2));
  return result;
}

/**
 * Helper function for testing custom splits
 */
function testCustomSplit() {
  const testParams = {
    group_name: "Test Group",
    amount: "150.00",
    description: "Test Custom Split",
    split_method: "custom",
    user_splits: [
      '{"user_id": "123456", "paid_share": "150.00", "owed_share": "75.00"}',
      '{"user_id": "789012", "paid_share": "0.00", "owed_share": "75.00"}'
    ], // Replace with actual user IDs from your group
    currency_code: "INR",
    debug: true
  };
  
  const result = createSplitwiseExpense(testParams);
  console.log('Custom Split Test Result:', JSON.stringify(result, null, 2));
  return result;
}


