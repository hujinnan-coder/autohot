import { defineServerModule } from "@aihot/backend/modules";
import { scanDueAccounts } from "./backend/scan.ts";

// Jina reads work with or without its API key: with one the paid tier is used, without it the
// free anonymous tier (20 RPM) — so the key must not gate the schedule.
export default defineServerModule({
  name: "weibo-monitor",
  schedules: [{
    name: "weibo-monitor.scan",
    cron: "*/10 * * * *",
    when: () => process.env.COLLECT_ENABLED === "true",
    run: scanDueAccounts,
  }],
});
