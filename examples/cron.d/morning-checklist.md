---
schedule: "0 7 * * *"
# notify: "123456789"  # or set cron.default_notify in config.yaml
steps:
  - new-session
  - prompt
---

Good morning. Run through your daily checklist:

1. Check system health and resource usage
2. Review any error logs from the past 24 hours
3. Summarise anything that needs attention
