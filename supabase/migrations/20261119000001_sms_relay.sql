-- Text messages read from a Mac's Messages app by a small relay the business runs on their Mac.
-- The relay posts each incoming text to /webhooks/sms/<token>; the token is the connection's external_id.
alter table channel_connections drop constraint channel_connections_kind_check;
alter table channel_connections add constraint channel_connections_kind_check
  check (kind in ('gmail', 'google_calendar', 'whatsapp', 'web_form', 'checkatrade_webhook', 'sms_relay'));
