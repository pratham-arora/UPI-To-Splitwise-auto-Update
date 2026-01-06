// This is an older file, and deprecated. I shifted from Pipedream to Google Script for a more free calls per day limit.

import { axios } from "@pipedream/platform"

export default defineComponent({
  name: "Create Splitwise Expense from iOS Shortcuts",
  description: "Process expense data from iOS Shortcuts and create expense in Splitwise group with automatic group lookup and user detection",
  type: "action",
  props: {
    api_key: {
      type: "string",
      label: "API Key",
      description: "Your Splitwise API Key",
      default: "mvWPNZ4VK1F4bV5H8SHkFZadZlsDYIwjIWZpLjvv",
      secret: true,
    },
    group_name: {
      type: "string",
      label: "Group Name",
      description: "The name of the Splitwise group",
      default: "{{steps.trigger.event.body['5'].Group}}",
    },
    amount: {
      type: "string",
      label: "Expense Amount",
      description: "The total amount of the expense",
      default: "{{steps.trigger.event.body['5'].Amount}}",
    },
    description: {
      type: "string", 
      label: "Expense Description",
      description: "Description of the expense",
      default: "{{steps.trigger.event.body['5'].Description}}",
    },
    split_method: {
      type: "string",
      label: "Split Method",
      description: "How to split the expense",
      default: "{{steps.trigger.event.body['5']['Split Method']}}",
      options: [
        { label: "Equal Split", value: "equal" },
        { label: "Custom Split", value: "custom" },
        { label: "Split Selected Equally", value: "split_selected_equally" }
      ],
    },
    currency_code: {
      type: "string",
      label: "Currency Code",
      description: "Currency code (e.g., USD, EUR, INR)",
      default: "INR",
      optional: true,
    },
    user_splits: {
      type: "string[]",
      label: "User Splits",
      description: "For custom splits, provide JSON objects with user_id, paid_share, and owed_share. Format: {\"user_id\": \"123\", \"paid_share\": \"50.00\", \"owed_share\": \"25.00\"}",
      optional: true,
    },
    selected_people: {
      type: "string",
      label: "Selected People",
      description: "For split selected equally, provide first names separated by commas (e.g., 'John,Jane,Bob') or leave empty to automatically get from iOS Shortcut request.",
      default: "{{steps.trigger.event.body['5'].selected_people}}",
      optional: true,
    },
    debug: {
      type: "boolean",
      label: "Enable Debug Mode",
      description: "Enable detailed logging for troubleshooting",
      default: false,
      optional: true,
    }
  },
  methods: {
    async makeAuthenticatedRequest($, method, url, data = null) {
      try {
        const requestConfig = {
          url: url,
          method: method,
          headers: {
            'Authorization': `Bearer ${this.api_key}`,
            'Accept': 'application/json',
          }
        };

        if (data) {
          requestConfig.headers['Content-Type'] = 'application/json';
          requestConfig.data = data;
        }

        if (this.debug) {
          console.log('Request Config:', JSON.stringify(requestConfig, null, 2));
        }

        const response = await axios($, requestConfig);
        
        if (this.debug) {
          console.log('Response Status:', response.status || 'Success');
          console.log('Response Data:', JSON.stringify(response, null, 2));
        }

        return response;

      } catch (error) {
        if (this.debug) {
          console.log('Request Error:', error.message);
          console.log('Error Response:', error.response?.data);
          console.log('Error Status:', error.response?.status);
        }

        // Enhanced error messages
        if (error.response?.status === 401) {
          throw new Error(`Authentication failed (401): ${error.response?.data?.errors?.[0]?.message || 'Invalid API key'}`);
        } else if (error.response?.status === 403) {
          throw new Error(`Access forbidden (403): ${error.response?.data?.errors?.[0]?.message || 'Insufficient permissions'}`);
        } else if (error.response?.data?.errors) {
          throw new Error(`Splitwise API error: ${error.response.data.errors.map(e => e.message || e).join(', ')}`);
        }

        throw error;
      }
    },

    async getCurrentUser($) {
      const userUrl = "https://secure.splitwise.com/api/v3.0/get_current_user";
      const response = await this.makeAuthenticatedRequest($, 'GET', userUrl);
      return response.user;
    },

    async findGroupByName($, groupName) {
      const groupsUrl = "https://secure.splitwise.com/api/v3.0/get_groups";
      const response = await this.makeAuthenticatedRequest($, 'GET', groupsUrl);

      const groups = response.groups || [];
      
      // Clean the input group name - remove all whitespace characters including newlines, tabs, etc.
      const cleanedInputName = groupName.replace(/\s+/g, '').toLowerCase();
      
      if (this.debug) {
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

      if (this.debug) {
        console.log('Matched group:', targetGroup.name);
      }

      return targetGroup;
    }
  },
  async run({ $ }) {
    // Validate required fields
    if (!this.amount || !this.description || !this.group_name) {
      throw new Error("Missing required fields: amount, description, or group_name");
    }

    try {
      if (this.debug) {
        console.log('Starting Splitwise expense creation...');
        console.log('Group Name:', this.group_name);
        console.log('Amount:', this.amount);
        console.log('Description:', this.description);
        console.log('Split Method:', this.split_method);
        console.log('Selected People (from config):', this.selected_people);
        console.log('Selected People type:', typeof this.selected_people);
        console.log('Selected People length:', this.selected_people?.length);
        console.log('Full trigger event body:', JSON.stringify($.event?.body || 'No body available', null, 2));
        
        // Enhanced debugging for selected_people issue
        if ($.event?.body) {
          console.log('Event body exists');
          console.log('Event body[5]:', JSON.stringify($.event.body['5'], null, 2));
          console.log('Event body[5].selected_people:', $.event.body['5']?.selected_people);
          console.log('Event body.selected_people:', $.event.body.selected_people);
        } else {
          console.log('No event body found');
        }
      }

      // Get current user ID automatically
      const currentUser = await this.getCurrentUser($);
      const currentUserId = currentUser.id;

      if (this.debug) {
        console.log('Current User:', currentUser);
      }

      // Find group by name
      const group = await this.findGroupByName($, this.group_name);
      const groupId = group.id;
      const groupUsers = group.members || [];
      
      if (groupUsers.length === 0) {
        throw new Error("No users found in the specified group");
      }

      if (this.debug) {
        console.log('Found Group:', group);
        console.log('Group Users:', groupUsers);
      }

      // Prepare expense data
      const expenseData = {
        cost: this.amount,
        description: this.description,
        currency_code: this.currency_code,
        group_id: parseInt(groupId),
      };

      // Handle user splits based on split method
      if (this.split_method === "equal" || !this.split_method || this.split_method.toLowerCase() === "equal split") {
        // For equal split, just set split_equally flag
        expenseData.split_equally = true;
        // No user-specific data needed for equal splits
      }
      else if (this.split_method === "split_selected_equally") {
        // Split equally among selected people
        let selectedPeopleArray = null;
        
        if (this.debug) {
          console.log('=== SELECTED PEOPLE DEBUG START ===');
          console.log('Configured selected_people prop:', this.selected_people);
          console.log('Type of selected_people prop:', typeof this.selected_people);
          console.log('Is selected_people null?', this.selected_people === null);
          console.log('Is selected_people undefined?', this.selected_people === undefined);
          console.log('Request body exists:', !!$.event?.body);
        }
        
        // ALWAYS try to get from request body FIRST
        if ($.event?.body) {
          const requestBody = $.event.body;
          const bodySelectedPeople = requestBody['5']?.selected_people || requestBody.selected_people;
          
          if (this.debug) {
            console.log('Trying to get selected_people from request body...');
            console.log('requestBody["5"]:', requestBody['5']);
            console.log('Found selected_people in request:', bodySelectedPeople);
            console.log('Type of selected_people from request:', typeof bodySelectedPeople);
          }
          
          if (bodySelectedPeople) {
            selectedPeopleArray = bodySelectedPeople;
          }
        }
        
        // If nothing from request body, fall back to configured value
        if (!selectedPeopleArray && this.selected_people && typeof this.selected_people === 'string' && this.selected_people.trim()) {
          selectedPeopleArray = this.selected_people;
          
          if (this.debug) {
            console.log('Using configured selected_people:', selectedPeopleArray);
          }
        }
        
        if (this.debug) {
          console.log('Raw selectedPeopleArray before processing:', selectedPeopleArray);
          console.log('Type:', typeof selectedPeopleArray);
        }
        
        // Convert to array format regardless of source
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
        
        if (this.debug) {
          console.log('Final processed selectedPeopleArray:', selectedPeopleArray);
          console.log('Final type:', typeof selectedPeopleArray);
          console.log('Final is array:', Array.isArray(selectedPeopleArray));
          console.log('Final length:', selectedPeopleArray?.length);
          console.log('=== SELECTED PEOPLE DEBUG END ===');
        }
        
        if (!selectedPeopleArray || selectedPeopleArray.length === 0) {
          throw new Error("Split selected equally specified but no selected_people provided. Make sure your iOS Shortcut sends the selected people data in the request body.");
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

        if (this.debug) {
          console.log('Selected users:', selectedUsers);
        }

        // Calculate equal share among selected users
        const equalShare = (parseFloat(this.amount) / selectedUsers.length).toFixed(2);

        // Use flattened format for selected users
        selectedUsers.forEach((user, index) => {
          expenseData[`users__${index}__user_id`] = user.id;
          expenseData[`users__${index}__paid_share`] = user.id.toString() === currentUserId.toString() ? this.amount : "0.00";
          expenseData[`users__${index}__owed_share`] = equalShare;
        });
      }
      else {
        // Custom split - use flattened format
        if (!this.user_splits || this.user_splits.length === 0) {
          throw new Error("Custom splits specified but no user_splits provided");
        }

        this.user_splits.forEach((splitStr, index) => {
          try {
            const split = JSON.parse(splitStr);
            expenseData[`users__${index}__user_id`] = parseInt(split.user_id);
            expenseData[`users__${index}__paid_share`] = split.user_id.toString() === currentUserId.toString() ? this.amount : (split.paid_share || "0.00");
            expenseData[`users__${index}__owed_share`] = split.owed_share;
          } catch (parseError) {
            throw new Error(`Invalid JSON format in user_splits: ${splitStr}`);
          }
        });
      }

      if (this.debug) {
        console.log('Expense Data:', JSON.stringify(expenseData, null, 2));
      }

      // Create the expense with Bearer token authentication
      const expenseUrl = "https://secure.splitwise.com/api/v3.0/create_expense";
      const response = await this.makeAuthenticatedRequest($, 'POST', expenseUrl, expenseData);

      // Check for API errors
      if (response.errors && response.errors.length > 0) {
        throw new Error(`Splitwise API errors: ${response.errors.join(", ")}`);
      }

      const createdExpense = response.expenses?.[0];
      
      if (!createdExpense) {
        throw new Error("Expense creation failed - no expense returned");
      }

      $.export("$summary", `Successfully created expense "${this.description}" for ₹${this.amount} in Splitwise group "${this.group_name}"`);

      return {
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
          split_method: this.split_method || "equal",
          total_amount: this.amount,
          currency: this.currency_code,
        }
      };

    } catch (error) {
      $.export("$summary", `Failed to create Splitwise expense: ${error.message}`);
      
      if (this.debug) {
        console.log('Full Error Details:', error);
      }
      
      throw new Error(`Splitwise expense creation failed: ${error.message}`);
    }
  }

})
