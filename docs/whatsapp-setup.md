# WhatsApp: setting it up and testing it

The goal is that a sole trader with **one phone number** uses it for everything:

- Customers message their number, and they see every chat in the WhatsApp Business app as now.
- The platform writes replies; approved replies are sent from their number.
- Approval requests arrive in the same app as one extra chat from the platform's number ("Your Assistant"), or they approve in the admin app.
- People saved in their phone are left alone unless they're already customers. "Not a customer? Ignore" deals with anyone else.
- If they answer a customer themselves in the app, the waiting draft is dropped, so nobody gets two replies.

Connecting a number that stays in the WhatsApp Business app (Meta calls it **coexistence**) needs Meta to approve the platform as a **Tech Provider**. That takes weeks, so there are two parts: **test now** with Meta's free test numbers, and **apply** in parallel.

Meta moves its menus around. If a screen doesn't match, Claude can walk through it with you in Chrome; you handle the keys and Bitwarden.

---

## Part A: test now (about 30 minutes)

You need: your phone with WhatsApp, a Facebook login, and Bitwarden.

### A1. The "business" number (Meta's test number)
1. Go to **developers.facebook.com** → **My Apps** → **Create app**. Choose the use case **Connect with customers through WhatsApp**, and the business portfolio you want it under. Name it, for example, "Assistant test business".
2. Open **WhatsApp → API Setup**. Meta has given the app a **test number**. Note its **Phone number ID** (not the phone number itself).
3. Under **To**, add **your own WhatsApp number**. Meta sends a code to your WhatsApp; type it in. (The test number can only send to numbers added here, up to 5.)
4. Make a token that doesn't expire: **business.facebook.com → Settings → Users → System users** → add one (Admin) → **Assign assets**: the app and the WhatsApp account, with full control → **Generate token** with the permissions `whatsapp_business_messaging` and `whatsapp_business_management`. Copy it straight into Bitwarden as a note for now (it goes into the admin app in A3, not into Fly).
5. **App settings → Basic → App secret** → Show → copy it into Bitwarden as `WA_APP_SECRET`.
6. Make up a random string and save it in Bitwarden as `WA_VERIFY_TOKEN`.

### A2. Point Meta at the platform
1. In GitHub, run **Deploy production** so the app has the two new secrets.
2. Back in the Meta app: **WhatsApp → Configuration → Webhook → Edit**.
   - Callback URL: `https://aaas-platform.fly.dev/webhooks/whatsapp`
   - Verify token: the same string as `WA_VERIFY_TOKEN`
   - **Verify and save**. Then under **Webhook fields**, subscribe to **messages**.

### A3. Connect the test number to Test Business
In the admin app: **Test Business → Connections → Connect a number by its ID**. Paste the **Phone number ID** from A1.2 (a long number such as `106540352242922`, shown under the number on API Setup; not the phone number itself, and not the WhatsApp Business Account ID), the **WhatsApp Business Account ID** (the other long number on the same page) and the token from A1.4. The app checks them with Meta, links the account to your app so its messages are sent here, and shows the number it found, for example "Connected +1 555 123 4567". (Then delete the token from your Bitwarden note: the app has it encrypted and never shows it again.)

### A4. Try it
1. From your phone, message the test number as a customer: "Hi, could you quote for a new kitchen floor next week?"
2. Within a few seconds, a reply is written and waiting in the admin app's **Inbox** ("1 customer needs you").
3. Open it and tap **Approve and send**. The reply arrives on your phone from the test number, and shows as **✓ Sent** in the thread.
4. Reply "Tuesday works" to see a booking confirmed (if Google is connected).

The AI needs Claude credit (Keys page → Claude → Test).

Owners are never messaged on WhatsApp by the platform. Replies waiting for them are in the Inbox; everything sent from their number also shows in their WhatsApp Business app.

---

## Part B: apply to Meta so real businesses can use their own number

Start now: Meta's checks take weeks.

1. **Verify the business** in **business.facebook.com → Security centre → Start verification**. You'll need the company's legal name, address, and a document (for example, a Companies House record or utility bill), and a business email or website on the same domain.
2. **App review**: in the developer app (one app for the platform), request **advanced access** to `whatsapp_business_messaging` and `whatsapp_business_management`. Meta asks for a short screen recording of each in use; the test in Part A is what you record.
3. **Become a Tech Provider**: in the app, **WhatsApp → Quickstart** (or **Partner solutions**), follow **Become a Tech Provider**. It requires steps 1 and 2.
4. **Set up Embedded Signup**: **Facebook Login for Business → Configurations → Create**, choosing the **WhatsApp Embedded Signup** variation with the two WhatsApp permissions. Copy the **Configuration ID** into Bitwarden as `META_SIGNUP_CONFIG_ID`, and the app's **App ID** as `META_APP_ID`. In **Facebook Login for Business → Settings**, add `aaas-platform.fly.dev` to **Allowed domains** and **Valid OAuth redirect URIs**.
5. **Webhook fields** on the app: add **smb_message_echoes** (the owner's own replies), **smb_app_state_sync** (saved contacts), and **account_update**, as well as **messages**.
6. Run **Deploy production**. The Keys page shows "WhatsApp Business app numbers" as set.

### Connecting a sole trader
1. Make sure they have the **WhatsApp Business app** (version 2.24.17 or later), not ordinary WhatsApp. Switching keeps their chats.
2. Admin app → their business → **Connections → Your WhatsApp Business number → Make a connect link**. Send it to them.
3. They open it, sign in to Facebook in Meta's own window, choose their number and confirm on their phone. We never see their password.
4. The platform asks Meta once for the contacts saved in their app (kept only as one-way hashes, no names). This has to happen within 24 hours of connecting, so it starts straight away. Message history is not imported: it would pull in personal chats.
5. In **Connections → Who gets an answer on WhatsApp**, choose **New people and customers** (the default, for a personal number) or **Everyone** (a work-only number).

### What coexistence doesn't do
- Group chats aren't seen. Broadcast lists become read-only.
- WhatsApp on Windows and WearOS are unlinked; WhatsApp on a Mac or the web still works.
- Calls, disappearing messages and view-once still work in the app, but the platform doesn't see them.
