/**
 * Google Apps Script version of Splitwise Expense Creator
 * Converts iOS Shortcuts data to Splitwise expenses with automatic group lookup and user detection
 */

// Configuration - Set these values in the script editor
const CONFIG = {
  API_KEY: "mvWPNZ4VK1F4bV5H8SHkFZadZlsDYIwjIWZpLjvv", // Your Splitwise API Key
  CURRENCY_CODE: "INR", // Default currency
  DEBUG: false // Enable debug logging
};

/**
 * Main function to handle webhook requests from iOS Shortcuts
 * This function should be deployed as a web app
 */
function doPost(e) {
  try {
    const requestData = JSON.parse(e.postData.contents);
    
    if (CONFIG.DEBUG) {
      console.log('Received request data:', JSON.stringify(requestData, null, 2));
    }
    
    // Extract data from iOS Shortcuts format
    const expenseParams = {
      group_name: requestData['5']?.Group || requestData.Group,
      amount: requestData['5']?.Amount || requestData.Amount,
      description: requestData['5']?.Description || requestData.Description,
      split_method: requestData['5']?.['Split Method'] || requestData['Split Method'] || 'equal',
      selected_people: requestData['5']?.selected_people || requestData.selected_people,
      currency_code: CONFIG.CURRENCY_CODE,
      user_splits: requestData['5']?.user_splits || requestData.user_splits,
      debug: CONFIG.DEBUG
    };
    
    const result = createSplitwiseExpense(expenseParams);
    
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    console.error('Error in doPost:', error);
    
    const errorResult = {
      success: false,
      error: error.message || 'Unknown error occurred'
    };
    
    return ContentService
      .createTextOutput(JSON.stringify(errorResult))
      .setMimeType(ContentService.MimeType.JSON);
  }
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
 * Create Splitwise expense with given parameters
 */
function createSplitwiseExpense(params) {
  // Validate required fields
  if (!params.amount || !params.description || !params.group_name) {
    throw new Error("Missing required fields: amount, description, or group_name");
  }

  try {
    if (params.debug) {
      console.log('Starting Splitwise expense creation...');
      console.log('Group Name:', params.group_name);
      console.log('Amount:', params.amount);
      console.log('Description:', params.description);
      console.log('Split Method:', params.split_method);
      console.log('Selected People:', params.selected_people);
    }

    // Get current user ID automatically
    const currentUser = getCurrentUser(params.debug);
    const currentUserId = currentUser.id;

    if (params.debug) {
      console.log('Current User:', currentUser);
    }

    // Find group by name
    const group = findGroupByName(params.group_name, params.debug);
    const groupId = group.id;
    const groupUsers = group.members || [];
    
    if (groupUsers.length === 0) {
      throw new Error("No users found in the specified group");
    }

    if (params.debug) {
      console.log('Found Group:', group);
      console.log('Group Users:', groupUsers);
    }

    // Prepare expense data
    const expenseData = {
      cost: params.amount,
      description: params.description,
      currency_code: params.currency_code || CONFIG.CURRENCY_CODE,
      group_id: parseInt(groupId),
    };

    // Handle user splits based on split method
    if (params.split_method === "equal" || !params.split_method || params.split_method.toLowerCase() === "equal split") {
      // For equal split, just set split_equally flag
      expenseData.split_equally = true;
      // No user-specific data needed for equal splits
    }
    else if (params.split_method === "split_selected_equally") {
      // Split equally among selected people
      let selectedPeopleArray = processSelectedPeople(params.selected_people, params.debug);
      
      if (!selectedPeopleArray || selectedPeopleArray.length === 0) {
        throw new Error("Split selected equally specified but no selected_people provided. Make sure your iOS Shortcut sends the selected people data.");
      }

      // Find selected users by first name
      const selectedUsers = [];
      for (const firstName of selectedPeopleArray) {
        const user = groupUsers.find(u => 
          u.first_name && u.first_name.toLowerCase().trim() === firstName.toLowerCase().trim()
        );
        if (user) {
          selectedUsers.push(user);
        } else {
          throw new Error(`User with first name "${firstName}" not found in group. Available users: ${groupUsers.map(u => u.first_name).join(', ')}`);
        }
      }

      if (params.debug) {
        console.log('Selected users:', selectedUsers);
      }

      // Calculate equal share among selected users
      const equalShare = (parseFloat(params.amount) / selectedUsers.length).toFixed(2);

      // Use flattened format for selected users
      selectedUsers.forEach((user, index) => {
        expenseData[`users__${index}__user_id`] = user.id;
        expenseData[`users__${index}__paid_share`] = user.id.toString() === currentUserId.toString() ? params.amount : "0.00";
        expenseData[`users__${index}__owed_share`] = equalShare;
      });
    }
    else {
      // Custom split - use flattened format
      if (!params.user_splits || params.user_splits.length === 0) {
        throw new Error("Custom splits specified but no user_splits provided");
      }

      params.user_splits.forEach((splitStr, index) => {
        try {
          const split = JSON.parse(splitStr);
          expenseData[`users__${index}__user_id`] = parseInt(split.user_id);
          expenseData[`users__${index}__paid_share`] = split.user_id.toString() === currentUserId.toString() ? params.amount : (split.paid_share || "0.00");
          expenseData[`users__${index}__owed_share`] = split.owed_share;
        } catch (parseError) {
          throw new Error(`Invalid JSON format in user_splits: ${splitStr}`);
        }
      });
    }

    if (params.debug) {
      console.log('Expense Data:', JSON.stringify(expenseData, null, 2));
    }

    // Create the expense with Bearer token authentication
    const expenseUrl = "https://secure.splitwise.com/api/v3.0/create_expense";
    const response = makeAuthenticatedRequest('POST', expenseUrl, expenseData, params.debug);

    // Check for API errors
    if (response.errors && response.errors.length > 0) {
      throw new Error(`Splitwise API errors: ${response.errors.join(", ")}`);
    }

    const createdExpense = response.expenses?.[0];
    
    if (!createdExpense) {
      throw new Error("Expense creation failed - no expense returned");
    }

    const result = {
      success: true,
      expense_id: createdExpense.id,
      expense: createdExpense,
      group_info: {
        group_id: groupId,
        group_name: group.name,
      },
      user_info: {
        current_user_id: currentUserId,
        current_user_name: currentUser.first_name + ' ' + currentUser.last_name,
      },
      split_info: {
        split_method: params.split_method || "equal",
        total_amount: params.amount,
        currency: params.currency_code || CONFIG.CURRENCY_CODE,
      },
      summary: `Successfully created expense "${params.description}" for ₹${params.amount} in Splitwise group "${params.group_name}"`
    };

    if (params.debug) {
      console.log('Success Result:', JSON.stringify(result, null, 2));
    }

    return result;

  } catch (error) {
    if (params.debug) {
      console.log('Full Error Details:', error);
    }
    
    throw new Error(`Splitwise expense creation failed: ${error.message}`);
  }
}

/**
 * Make authenticated HTTP request to Splitwise API
 */
function makeAuthenticatedRequest(method, url, data = null, debug = false) {
  try {
    const options = {
      method: method,
      headers: {
        'Authorization': `Bearer ${CONFIG.API_KEY}`,
        'Accept': 'application/json',
      }
    };

    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.payload = JSON.stringify(data);
    }

    if (debug) {
      console.log('Request Config:', JSON.stringify({
        url: url,
        method: method,
        headers: options.headers,
        payload: options.payload
      }, null, 2));
    }

    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (debug) {
      console.log('Response Status:', responseCode);
      console.log('Response Data:', responseText);
    }

    if (responseCode < 200 || responseCode >= 300) {
      let errorMessage = `HTTP ${responseCode}`;
      try {
        const errorData = JSON.parse(responseText);
        if (responseCode === 401) {
          errorMessage = `Authentication failed (401): ${errorData.errors?.[0]?.message || 'Invalid API key'}`;
        } else if (responseCode === 403) {
          errorMessage = `Access forbidden (403): ${errorData.errors?.[0]?.message || 'Insufficient permissions'}`;
        } else if (errorData.errors) {
          errorMessage = `Splitwise API error: ${errorData.errors.map(e => e.message || e).join(', ')}`;
        }
      } catch (parseError) {
        errorMessage = `HTTP ${responseCode}: ${responseText}`;
      }
      throw new Error(errorMessage);
    }

    return JSON.parse(responseText);

  } catch (error) {
    if (debug) {
      console.log('Request Error:', error.message);
    }
    throw error;
  }
}

/**
 * Get current Splitwise user
 */
function getCurrentUser(debug = false) {
  const userUrl = "https://secure.splitwise.com/api/v3.0/get_current_user";
  const response = makeAuthenticatedRequest('GET', userUrl, null, debug);
  return response.user;
}

/**
 * Find Splitwise group by name with fuzzy matching
 */
function findGroupByName(groupName, debug = false) {
  const groupsUrl = "https://secure.splitwise.com/api/v3.0/get_groups";
  const response = makeAuthenticatedRequest('GET', groupsUrl, null, debug);

  const groups = response.groups || [];
  
  // Clean the input group name - remove all whitespace characters including newlines, tabs, etc.
  const cleanedInputName = groupName.replace(/\s+/g, '').toLowerCase();
  
  if (debug) {
    console.log('Original input group name:', groupName);
    console.log('Cleaned input group name:', cleanedInputName);
    console.log('Available groups:', groups.map(g => g.name));
  }

  // Try exact match first (after cleaning)
  let targetGroup = groups.find(group => {
    const cleanedGroupName = group.name.replace(/\s+/g, '').toLowerCase();
    return cleanedGroupName === cleanedInputName;
  });

  // If no exact match, try partial matching
  if (!targetGroup) {
    targetGroup = groups.find(group => {
      const cleanedGroupName = group.name.replace(/\s+/g, '').toLowerCase();
      return cleanedInputName.startsWith(cleanedGroupName) || 
             cleanedGroupName.includes(cleanedInputName) ||
             cleanedInputName.includes(cleanedGroupName);
    });
  }

  if (!targetGroup) {
    throw new Error(`Group matching "${groupName}" not found. Available groups: ${groups.map(g => g.name).join(', ')}`);
  }

  if (debug) {
    console.log('Matched group:', targetGroup.name);
  }

  return targetGroup;
}

/**
 * Process selected people from various input formats
 */
function processSelectedPeople(selectedPeopleInput, debug = false) {
  let selectedPeopleArray = null;
  
  if (debug) {
    console.log('=== SELECTED PEOPLE DEBUG START ===');
    console.log('Input selected_people:', selectedPeopleInput);
    console.log('Type of selected_people:', typeof selectedPeopleInput);
    console.log('Is selected_people null?', selectedPeopleInput === null);
    console.log('Is selected_people undefined?', selectedPeopleInput === undefined);
  }
  
  if (selectedPeopleInput && typeof selectedPeopleInput === 'string' && selectedPeopleInput.trim()) {
    selectedPeopleArray = selectedPeopleInput;
    
    if (debug) {
      console.log('Using provided selected_people:', selectedPeopleArray);
    }
  }
  
  if (debug) {
    console.log('Raw selectedPeopleArray before processing:', selectedPeopleArray);
    console.log('Type:', typeof selectedPeopleArray);
  }
  
  // Convert to array format
  if (typeof selectedPeopleArray === 'string' && selectedPeopleArray.trim()) {
    // Handle string formats
    if (selectedPeopleArray.startsWith('[') && selectedPeopleArray.endsWith(']')) {
      // JSON array format: "[\"John\",\"Jane\"]"
      try {
        selectedPeopleArray = JSON.parse(selectedPeopleArray);
      } catch (e) {
        // If JSON parse fails, treat as comma-separated
        selectedPeopleArray = selectedPeopleArray.slice(1, -1).split(',').map(s => s.replace(/['"]/g, '').trim());
      }
    } else if (selectedPeopleArray.includes('\n')) {
      // Newline-separated: "John\nJane"
      selectedPeopleArray = selectedPeopleArray.split('\n').map(s => s.trim()).filter(s => s.length > 0);
    } else if (selectedPeopleArray.includes(',')) {
      // Comma-separated: "John,Jane,Bob"
      selectedPeopleArray = selectedPeopleArray.split(',').map(s => s.trim()).filter(s => s.length > 0);
    } else {
      // Single name: "John"
      selectedPeopleArray = [selectedPeopleArray.trim()];
    }
  } else if (!Array.isArray(selectedPeopleArray)) {
    selectedPeopleArray = [];
  }
  
  // Filter out any empty strings from the array
  if (Array.isArray(selectedPeopleArray)) {
    selectedPeopleArray = selectedPeopleArray.filter(name => name && name.trim().length > 0);
  }
  
  if (debug) {
    console.log('Final processed selectedPeopleArray:', selectedPeopleArray);
    console.log('Final type:', typeof selectedPeopleArray);
    console.log('Final is array:', Array.isArray(selectedPeopleArray));
    console.log('Final length:', selectedPeopleArray?.length);
    console.log('=== SELECTED PEOPLE DEBUG END ===');
  }
  
  return selectedPeopleArray;
}

/**
 * Helper function for manual testing with different split methods
 */
function testSplitSelectedEqually() {
  const testParams = {
    group_name: "Test Group",
    amount: "120.00",
    description: "Test Split Selected Equally",
    split_method: "split_selected_equally",
    selected_people: "Alice,Bob,Charlie", // Replace with actual names from your group
    currency_code: "INR",
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
