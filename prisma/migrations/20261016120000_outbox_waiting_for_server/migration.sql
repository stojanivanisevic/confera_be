-- A message that no mail server can send waits in a state of its own (UXUI-M2-01): the
-- worker does not look at it; adding or changing a mail server makes it due again.
ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_status_check";
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_status_check"
    CHECK ("status" IN ('queued', 'sending', 'sent', 'failed', 'held', 'stuck', 'waiting_for_server'));

