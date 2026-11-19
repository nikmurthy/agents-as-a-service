# Text messages from a Mac

Lets a business's texts (SMS) become enquiries, with no phone provider to set up. Their iPhone already
copies texts to their Mac's Messages app; this small relay reads new incoming texts there and posts them to
the platform. Replies still go through approval as usual, and the owner is told "Text this to …" with the
approved wording.

## What it reads

- Only **incoming texts (SMS and RCS)**, never iMessages, never anything you sent.
- Only texts from **real phone numbers**: bank codes, delivery alerts and other named or short senders are skipped.
- Only texts that arrive **after the relay first starts**. Old texts are never sent.
- It reads Messages and never changes it.

Every text from a phone number is sent, including personal ones. It works best on a Mac signed in to the
**business** phone's Apple ID.

## Set up (about 5 minutes, on the business's Mac)

1. **On the iPhone:** Settings → Apps → Messages → Text Message Forwarding → turn on this Mac.
   Check that a text to the phone shows up in Messages on the Mac.
2. **In the admin app:** the business → Connections → **Text messages from a Mac**. Copy the link.
3. **On the Mac**, in Terminal (Node 18 or later must be installed):

   ```sh
   AAAS_SMS_URL='<the link>' bash tools/mac-sms-relay/install.sh
   ```

   This starts the relay now and every time the Mac starts.
4. **Give it permission:** System Settings → Privacy & Security → **Full Disk Access** → add `node`
   (the installer prints its location). macOS keeps Messages private without this.
5. Send a test text to the business phone. It appears in the admin app's Inbox within a minute.

The Mac needs to be on and awake for texts to come through. Logs: `~/Library/Logs/aaas-sms-relay.log`.

To stop it: `bash tools/mac-sms-relay/install.sh --remove`.
