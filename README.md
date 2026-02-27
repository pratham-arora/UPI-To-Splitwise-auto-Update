# UPI To Splitwise — Auto Update

Automatically create Splitwise expenses from UPI payment SMS on Android using **Tasker** and **make.com**.

---

## How It Works

```
Android UPI SMS
  └─ Tasker (SMS trigger)
       ├─ Parses amount + merchant from SMS
       ├─ Fetches your Splitwise groups
       ├─ Shows dialogs: group / amount / description / split method
       └─ HTTP POST → make.com Webhook
              └─ make.com Scenario
                   ├─ Calls Splitwise API: find group_id
                   ├─ Calls Splitwise API: get current user
                   ├─ Creates expense (equal or split_selected_equally)
                   └─ Returns result → Tasker notification
```

---

## Requirements

| Tool | Cost | Purpose |
|------|------|---------|
| [Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm) | ~€3.5 one-time | Android automation (SMS trigger + dialogs) |
| [make.com](https://make.com) | Free (1000 ops/month) | Cloud webhook → Splitwise API relay |
| Splitwise API key | Free | From https://secure.splitwise.com/apps |

---

## Supported UPI SMS Formats

| Bank / App | SMS Pattern |
|------------|-------------|
| HDFC | `Rs.500.00 debited from A/c XX1234 ... UPI ...` |
| SBI | `Your A/c XXXX debited Rs 1200 via UPI Ref ...` |
| ICICI | `INR 300.00 debited from your ICICI Bank Account ... UPI:...` |
| Axis | `INR 750 is debited ... VPA merchant@upi ...` |
| Kotak | `Rs. 200 has been debited via UPI ...` |
| PNB | `Rs.400 deducted via UPI Ref ...` |
| GPay / PhonePe | `You have paid Rs. 500 to John via UPI` |

---

## Setup

### Step 1 — Get your Splitwise API Key

1. Go to https://secure.splitwise.com/apps
2. Click **"Register your application"**
3. Fill in any name/description, submit
4. Copy the **API Key** shown on the next screen

---

### Step 2 — Set up make.com

1. Create a free account at [make.com](https://make.com)
2. Go to **Scenarios** → click **"Create a new scenario"**
3. Click **"..."** (three dots, top right) → **"Import Blueprint"**
4. Upload `make-com/scenario-blueprint.json` from this repository

5. **Configure the Webhook (Module 1):**
   - Click on the **Webhooks** module
   - Click **"Add"** → **"Create a webhook"**
   - Name it `Tasker UPI Webhook`
   - Copy the webhook URL — you will need it in Step 3

6. **Test Module 2 (Get Groups):**
   - The Authorization header uses `{{1.api_key}}` from the webhook payload
   - No changes needed

7. **For Equal Split (most common):**
   - Module 6 body uses `split_equally: true` — Splitwise handles all math automatically
   - No further configuration needed for this branch

8. **For Split Selected Equally (optional, advanced):**
   - Module 9 needs manual configuration (see [Advanced: Split Selected](#advanced-split-selected-equally) below)

9. Click **"Save"** → toggle the scenario **ON**

10. **Send a test request** to verify:
    ```bash
    curl -X POST "YOUR_MAKE_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d '{
        "api_key": "YOUR_SPLITWISE_API_KEY",
        "group_name": "YourGroupName",
        "amount": "50",
        "description": "Test expense",
        "split_method": "equal"
      }'
    ```
    Check Splitwise — a test expense should appear.

---

### Step 3 — Set up Tasker

#### 3a. Set Global Variables

In Tasker: tap **"..."** (three dots) → **Preferences** → **Variables** tab → **+** button

Add these two global variables:

| Variable Name | Value |
|---------------|-------|
| `SPLITWISE_API_KEY` | Your Splitwise API key from Step 1 |
| `MAKE_WEBHOOK_URL` | Your make.com webhook URL from Step 2 |

> **Security note:** Global variables are stored locally on your device and are NOT exported when you share the Tasker XML files.

#### 3b. Import the Task

1. In Tasker, long-press the **Tasks** tab
2. Tap **"Import Task"**
3. Select `tasker/upi-splitwise-task.xml`

#### 3c. Import the Profile

1. In Tasker, long-press the **Profiles** tab
2. Tap **"Import Profile"**
3. Select `tasker/upi-splitwise-profile.xml`
4. When asked which task to link, select **"UPI to Splitwise"**

#### 3d. Test the Task

Before triggering via real SMS, test manually:

1. Open the **"UPI to Splitwise"** task in Tasker
2. Tap **▶ Play** (run button)
3. In the `%SMSRB` prompt that appears, paste a sample SMS:
   ```
   Rs.150.00 debited from your HDFC Bank account ending 1234 to VPA testmerchant@okaxis on 27-02-26. UPI Ref 123456789
   ```
4. Walk through all dialogs and confirm the expense appears in Splitwise

---

## How a Typical Expense Is Created

1. You make a UPI payment (any app)
2. Your bank sends an SMS — Tasker detects it automatically
3. A series of dialogs appears:
   - **Select Group**: choose which Splitwise group to add the expense to
   - **Confirm Amount**: pre-filled from SMS, edit if needed
   - **Description**: pre-filled with merchant VPA, edit to something readable
   - **Split Method**: Equal Split or Split Selected Equally
4. Tasker sends the data to make.com
5. make.com calls the Splitwise API and creates the expense
6. A notification confirms success: `"Created: Coffee (₹150) in Flatmates"`

---

## Split Methods

### Equal Split (default)
Divides the amount equally among **all members** of the selected group.
Uses Splitwise's `split_equally: true` — Splitwise handles rounding automatically.

### Split Selected Equally
Divides the amount equally among **selected members only**.
After choosing this method, a sequential dialog asks you to pick each person.
Uses penny-fix logic to ensure the total always adds up exactly.

---

## Advanced: Split Selected Equally

To fully configure the `split_selected_equally` branch in make.com:

1. After Module 7 (Calculate Share Amounts), add an **Iterator** module:
   - Array: `{{split(1.selected_people; ",")}}`

2. For each person, add an **HTTP module** to find their user ID:
   - Search the group members array (from Module 8) for a name match
   - Store `user_id`, `owed_share` (base_share ± penny), `paid_share`

3. Add an **Array Aggregator** to collect all user objects

4. In Module 9 (Create Expense), build the body dynamically with the aggregated array

5. The payer (current user from Module 3) gets `paid_share = total_amount`, `owed_share = their_calculated_share`

> **Tip:** For most use cases, Equal Split is sufficient. Consider starting with that and adding Split Selected later.

---

## File Structure

```
UPI-To-Splitwise-auto-Update/
├── tasker/
│   ├── upi-splitwise-profile.xml   Tasker Profile (SMS trigger)
│   └── upi-splitwise-task.xml      Tasker Task (dialogs + HTTP)
├── make-com/
│   └── scenario-blueprint.json     make.com scenario (import this)
├── google-apps-script.gs           DEPRECATED — kept for reference
├── process_splitwise_expense.js    DEPRECATED — original Pipedream version
└── README.md                       This file
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Tasker doesn't trigger on SMS | Check the profile is enabled (green checkbox). Verify SMS permissions granted to Tasker. |
| "Could not parse UPI amount" flash | Your bank SMS format isn't covered. Check `tasker/upi-splitwise-profile.xml` regex and extend it. |
| make.com scenario not running | Verify the webhook URL in `%MAKE_WEBHOOK_URL` is correct. Check make.com execution history for errors. |
| "Group not found" error | Group name must partially match. Check capitalization. |
| Amount shown as 0 | SMS regex didn't capture a number. Test with a manual `%SMSRB` value in Tasker. |
| Splitwise shows wrong payer | make.com uses `get_current_user` to identify you. Ensure the API key belongs to the person paying. |

---

## Operations Count (make.com Free Tier)

| Scenario | Operations per Expense |
|----------|----------------------|
| Equal Split | 3 (get groups + get user + create expense) |
| Split Selected Equally | 4–5 (+ iterator per person) |
| **Free tier limit** | **1,000 ops/month** |
| **Effective capacity** | ~250–333 expenses/month free |
