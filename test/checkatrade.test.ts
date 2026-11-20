// Reading Checkatrade's emails: different layouts, follow-up messages, and the emails that aren't enquiries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkatradeJobLink, parseCheckatradeEmail, parseCheckatradeWebhook, parseGmail } from "../src/channels/parse.js";
import { findContactDetails, suggestForLead } from "../src/leads.js";
import { gmailMsg } from "./fakes.js";

test("table layout with bold labels", () => {
  const m = parseCheckatradeEmail({ subject: "New lead: Flooring in BS16", html:
    `<table><tr><td><b>Job</b></td><td>LVT kitchen</td></tr><tr><td><b>Description</b></td><td>Click LVT in kitchen diner, about 25m&sup2;.</td></tr>
     <tr><th>Customer name</th><td>Chloe Bennett</td></tr><tr><td><strong>Phone number:</strong></td><td>07700 900801</td></tr>
     <tr><td>Email address</td><td><a href="mailto:chloe@example.com">chloe@example.com</a></td></tr><tr><td>Postcode</td><td>BS16 2AB</td></tr>
     <tr><td>Job reference</td><td>CT-88231</td></tr></table>` })!;
  assert.equal(m.channel, "checkatrade");
  assert.deepEqual(m.from, { name: "Chloe Bennett", email: "chloe@example.com", phone: "+447700900801" });
  assert.match(m.text, /^Click LVT in kitchen diner/);
  assert.equal(m.structured!.Job, "LVT kitchen");
  assert.equal(m.structured!.Postcode, "BS16 2AB");
  assert.equal(m.structured!["Job reference"], "CT-88231");
  assert.equal(m.structured!["Checkatrade email"], "New lead");
  assert.ok(!("Customer name" in m.structured!) && !("Email address" in m.structured!), "contact details stay out of the job details");
});

test("plain text layout, labels on their own line", () => {
  const m = parseCheckatradeEmail({ subject: "You have a new job request", text:
    "Hi Mark,\n\nYou've received a new job request.\n\nName\nPriya Shah\nTelephone\n07700 900802\nJob title\nRe-carpet stairs and landing\nDetails\nWool carpet please, 14 stairs plus landing.\nWhen\nWithin 2 weeks\n\nThanks,\nCheckatrade" })!;
  assert.equal(m.from.name, "Priya Shah");
  assert.equal(m.from.phone, "+447700900802");
  assert.equal(m.text, "Wool carpet please, 14 stairs plus landing.");
  assert.equal(m.structured!.Job, "Re-carpet stairs and landing");
  assert.equal(m.structured!["Preferred start"], "Within 2 weeks");
});

test("new message from a customer, with the job reference only in the subject", () => {
  const m = parseCheckatradeEmail({ subject: "New message about job ref CT-88231", text: "Chloe has sent you a message:\n\nCould you do Saturday instead?\n\nReply in the Checkatrade app." })!;
  assert.equal(m.structured!["Job reference"], "CT-88231");
  assert.equal(m.structured!["Checkatrade email"], "Message from the customer");
  assert.match(m.text, /Saturday/);
  assert.equal(m.from.email, undefined);
});

test("Checkatrade's own address is never taken as the customer's", () => {
  const m = parseCheckatradeEmail({ subject: "New lead", text: "Email: noreply@checkatrade.com\nDescription: Fit laminate in hall" })!;
  assert.equal(m.from.email, undefined);
});

test("reviews, invoices and account emails are not enquiries", () => {
  for (const subject of ["You've got a new review", "Your Checkatrade invoice is ready", "Verify your email address", "Your membership renewal"]) {
    assert.equal(parseCheckatradeEmail({ subject, text: "Hi Mark,\nLog in to your account to see more.\nThe Checkatrade team" }), null, subject);
  }
  assert.equal(parseCheckatradeEmail({ subject: "Tips for a great profile", text: "Add photos to your profile." }), null);
});

test("Gmail: Checkatrade lead keeps no email thread; other senders do", () => {
  const ct = parseGmail(gmailMsg({ id: "g1", from: "Checkatrade <leads@notifications.checkatrade.com>", to: "o@b.example", subject: "New lead", text: "Description: Oak floor\nPhone: 07700 900803" }), { checkatradeSenders: [] })!;
  assert.equal(ct.channel, "checkatrade");
  assert.equal(ct.email, undefined, "a reply by email must not go into Checkatrade's notification thread");
  const forwarded = parseGmail(gmailMsg({ id: "g2", from: "Lead Forwarder <ops@business.example>", to: "o@b.example", subject: "New lead", text: "Description: Vinyl\nPhone: 07700 900804" }), { checkatradeSenders: ["ops@business.example"] })!;
  assert.equal(forwarded.channel, "checkatrade", "addresses listed in Settings count as Checkatrade");
  const normal = parseGmail(gmailMsg({ id: "g3", from: "Ann <ann@example.com>", to: "o@b.example", subject: "Quote", text: "Hello" }), { checkatradeSenders: [] })!;
  assert.equal(normal.email?.threadId, "t-g3");
  assert.equal(parseGmail(gmailMsg({ id: "g4", from: "noreply@checkatrade.com", to: "o@b.example", subject: "Your invoice", text: "Amount due" }), { checkatradeSenders: [] }), null);
});

test("job link: the members' app link, not unsubscribe or help links", () => {
  assert.equal(checkatradeJobLink(`<a href="https://www.checkatrade.com/unsubscribe">x</a><a href="https://membersapp.checkatrade.com/jobs/j-1?utm=a&amp;b=2">View</a>`),
    "https://membersapp.checkatrade.com/jobs/j-1?utm=a&b=2");
  assert.equal(checkatradeJobLink("Visit https://www.checkatrade.com/support/trade for help."), undefined);
  const w = parseCheckatradeWebhook({ jobId: "J9", title: "Windows", tradeWebUrl: "https://membersapp.checkatrade.com/jobs/J9" });
  assert.equal(w.structured!["Job link"], "https://membersapp.checkatrade.com/jobs/J9");
  assert.equal(w.structured!["Job reference"], "J9");
});

test("customer details pasted by the owner, in the ways people type them", () => {
  assert.deepEqual(findContactDetails("07700 900811"), { email: undefined, phone: "+447700900811" });
  assert.deepEqual(findContactDetails("her email is Chloe.B@Example.com"), { email: "chloe.b@example.com", phone: undefined });
  assert.deepEqual(findContactDetails("+44 7700 900812, chloe@ex.co.uk"), { email: "chloe@ex.co.uk", phone: "+447700900812" });
  assert.deepEqual(findContactDetails("thanks, all done"), { email: undefined, phone: undefined });
  assert.deepEqual(findContactDetails("job 12345"), { email: undefined, phone: undefined }, "short numbers aren't phone numbers");
});

test("suggestion: spam and out-of-area leads are Not for me, the rest Interested", () => {
  const t = { intent: "quote_request", urgency: "normal", needsHuman: false, nextStep: "book_visit", missingInfo: [], reason: "" } as any;
  assert.deepEqual(suggestForLead(t), { suggestion: "interested" });
  assert.deepEqual(suggestForLead({ ...t, inServiceArea: false }), { suggestion: "not_for_me", reason: "Outside the area we cover" });
  assert.deepEqual(suggestForLead({ ...t, intent: "spam", nextStep: "ignore" }), { suggestion: "not_for_me", reason: "This job is spam" });
});
