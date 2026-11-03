import type { GoogleClient } from "./google.js";
import { googleRest } from "./google.js";
import type { WhatsAppClient } from "./whatsapp.js";
import { whatsAppCloud } from "./whatsapp.js";

// One place to swap real clients for fakes (tests) or alternatives (e.g. Microsoft Graph for Outlook later).
export const clients: { google: GoogleClient; whatsapp: WhatsAppClient } = {
  google: googleRest,
  whatsapp: whatsAppCloud,
};
