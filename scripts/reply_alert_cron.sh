#!/bin/bash
# Wrapper: pipe the reply-alert script into the running api container.
cat /opt/email/scripts/reply_alert_cron.mjs | docker exec -i email_api node --input-type=module
