-- 0023: extend inbox_replies.classification with the finer TZ §11 reply classes.
-- Purely additive — adding ENUM values leaves every existing value and row unchanged.
-- The classifier (api/src/services/replyClassifier.ts) now emits these; without this
-- ALTER, inserting a 'complaint'/'legal_or_privacy'/etc reply would fail.
--
-- ROLLBACK (only if no row uses a new value):
--   ALTER TABLE inbox_replies MODIFY COLUMN classification
--     ENUM('interested','not_interested','do_not_contact','unsubscribe','wrong_person',
--          'out_of_office','bounce_like','auto_reply','unknown') NOT NULL DEFAULT 'unknown';

ALTER TABLE inbox_replies MODIFY COLUMN classification
  ENUM('interested','not_interested','do_not_contact','unsubscribe','wrong_person',
       'out_of_office','bounce_like','auto_reply','unknown',
       'meeting_request','request_details','referral','complaint','legal_or_privacy','not_now')
  NOT NULL DEFAULT 'unknown';
